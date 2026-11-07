const CONTEXT_SOURCE = String.raw`(function (call, readState, log) {
  const parse = JSON.parse
  const stringify = JSON.stringify
  const invoke = (method, args) => new Promise((resolve, reject) => {
    call(method, stringify(args), (text) => resolve(text === undefined ? undefined : parse(text)), (code, message) => {
      const error = new Error(message)
      if (code) error.code = code
      reject(error)
    })
  })
  const remote = (name) => (...args) => invoke(name, args)
  const format = (args) => args.map((arg) => {
    if (typeof arg === 'string') return arg
    try {
      return stringify(arg)
    } catch {
      return String(arg)
    }
  }).join(' ')
  const write = (...args) => log(format(args))
  globalThis.page = Object.freeze({
    goto: remote('page.goto'),
    url: () => parse(readState()).url,
    title: () => parse(readState()).title,
    observe: remote('page.observe'),
    text: remote('page.text'),
    find: remote('page.find'),
    findAll: remote('page.findAll'),
    click: remote('page.click'),
    fill: remote('page.fill'),
    select: remote('page.select'),
    press: remote('page.press'),
    scroll: remote('page.scroll'),
    back: remote('page.back'),
    forward: remote('page.forward'),
    reload: remote('page.reload'),
    waitFor: remote('page.waitFor')
  })
  globalThis.task = Object.freeze({
    pages: () => parse(readState()).pages,
    newPage: remote('task.newPage'),
    switchTo: remote('task.switchTo'),
    closePage: remote('task.closePage')
  })
  globalThis.console = Object.freeze({ log: write, info: write, warn: write, error: write })
  globalThis.sleep = remote('sleep')
})`

export const SCRIPT_WORKER_SOURCE = String.raw`'use strict'
const vm = require('node:vm')
const CONTEXT_SOURCE = ${JSON.stringify(CONTEXT_SOURCE)}
const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 20000
let state = '{"url":"","title":"","pages":[]}'
let sequence = 0
let logLines = 0
let logChars = 0
const waiting = new Map()
process.on('unhandledRejection', () => {})
const send = (message) => {
  if (process.connected) process.send(message, () => {})
}
const call = (method, args, resolve, reject) => {
  const id = ++sequence
  waiting.set(id, { resolve, reject })
  send({ type: 'call', id, method, args })
}
const log = (line) => {
  if (logLines >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) return
  const text = String(line).slice(0, MAX_LOG_CHARS - logChars)
  logLines += 1
  logChars += text.length
  send({ type: 'log', line: text })
}
const finishError = (error) => {
  const code = error && typeof error.code === 'string' ? error.code : undefined
  send({ type: 'failed', ...(code ? { code } : {}), message: error && typeof error.message === 'string' ? error.message : String(error) })
}
const finish = (value) => {
  let text
  try {
    text = JSON.stringify(value === undefined ? null : value)
  } catch {
    text = JSON.stringify(String(value))
  }
  send({ type: 'done', result: text === undefined ? 'null' : text })
}
const run = (code) => {
  const context = vm.createContext(Object.create(null))
  vm.runInContext(CONTEXT_SOURCE, context)(call, () => state, log)
  let running
  try {
    running = vm.runInContext('(async () => {\n' + code + '\n})()', context, { timeout: 2000, filename: 'browser-script.js' })
  } catch (error) {
    finishError(error)
    return
  }
  Promise.resolve(running).then(finish, finishError)
}
process.on('message', (message) => {
  if (message.type === 'state') state = message.state
  else if (message.type === 'start') run(message.code)
  else if (message.type === 'reply') {
    const entry = waiting.get(message.id)
    if (!entry) return
    waiting.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(message.code, message.message)
  }
})
send({ type: 'ready' })
`
