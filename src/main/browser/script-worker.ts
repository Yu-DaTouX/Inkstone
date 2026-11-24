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
  const lower = (value) => String(value === undefined || value === null ? '' : value).toLowerCase()
  const asRegex = (value) => {
    if (value instanceof RegExp) return value
    if (typeof value === 'string' && value) return new RegExp(value, 'i')
    return null
  }
  const tests = (pattern, value) => {
    pattern.lastIndex = 0
    return pattern.test(String(value === undefined || value === null ? '' : value))
  }
  const matcher = (query) => {
    if (query instanceof RegExp) return (el) => tests(query, el.name) || tests(query, el.value)
    if (typeof query === 'string') {
      const needle = lower(query.trim())
      return (el) => lower(el.name).includes(needle) || lower(el.value).includes(needle)
    }
    const q = query && typeof query === 'object' ? query : {}
    const role = typeof q.role === 'string' ? lower(q.role.trim()) : ''
    const name = typeof q.name === 'string' ? lower(q.name.trim()) : ''
    const text = typeof q.text === 'string' ? lower(q.text.trim()) : ''
    const regex = asRegex(q.regex)
    return (el) => {
      if (role && lower(el.role) !== role) return false
      if (name && (q.exact === true ? lower(el.name).trim() !== name : !lower(el.name).includes(name))) return false
      if (text && !lower(el.name).includes(text) && !lower(el.value).includes(text)) return false
      if (regex && !tests(regex, el.name) && !tests(regex, el.value)) return false
      return true
    }
  }
  const findAll = async (query, fresh) => {
    const match = matcher(query)
    const hits = (await invoke('page.elements', [{ fresh: fresh === true }])).filter(match)
    if (hits.length || fresh === true) return hits
    return (await invoke('page.elements', [{ fresh: true }])).filter(match)
  }
  const target = async (query) => {
    if (typeof query === 'string') return query
    const hits = await findAll(query)
    if (hits.length === 1) return hits[0].ref
    const error = new Error(hits.length ? 'AMBIGUOUS_TARGET: ' + hits.length + ' 个元素匹配：' + hits.slice(0, 5).map((el) => el.ref + ' ' + el.role + ' ' + stringify(el.name)).join('；') + '，请写得更具体或用 ref' : 'TARGET_NOT_FOUND: 没有元素匹配 ' + (query instanceof RegExp ? String(query) : format([query])))
    error.code = hits.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND'
    throw error
  }
  const acting = (name) => async (query, ...rest) => invoke(name, [await target(query), ...rest])
  const text = async (options) => {
    const full = String(await invoke('page.text', []))
    if (!options || typeof options !== 'object') return full
    if (options.find !== undefined) {
      const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200))
      const out = []
      const regex = options.find instanceof RegExp ? new RegExp(options.find.source, options.find.flags.includes('g') ? options.find.flags : options.find.flags + 'g') : null
      if (regex) {
        let hit
        while (out.length < limit && (hit = regex.exec(full))) {
          out.push({ offset: hit.index, snippet: full.slice(Math.max(0, hit.index - 80), hit.index + hit[0].length + 80).replace(/\s+/g, ' ').trim() })
          if (hit[0].length === 0) regex.lastIndex += 1
        }
        return out
      }
      const needle = lower(options.find)
      if (!needle) return out
      const hay = lower(full)
      let from = 0
      while (out.length < limit) {
        const index = hay.indexOf(needle, from)
        if (index < 0) break
        out.push({ offset: index, snippet: full.slice(Math.max(0, index - 80), index + needle.length + 80).replace(/\s+/g, ' ').trim() })
        from = index + needle.length
      }
      return out
    }
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
    const size = options.maxChars === undefined ? full.length : Math.max(0, Math.floor(Number(options.maxChars) || 0))
    return full.slice(offset, offset + size)
  }
  globalThis.page = Object.freeze({
    goto: remote('page.goto'),
    url: () => parse(readState()).url,
    title: () => parse(readState()).title,
    observe: remote('page.observe'),
    snapshot: remote('page.snapshot'),
    text,
    find: async (query) => {
      const hit = (await findAll(query))[0]
      return hit ? hit.ref : null
    },
    findAll: (query) => findAll(query),
    click: acting('page.click'),
    fill: acting('page.fill'),
    select: acting('page.select'),
    press: remote('page.press'),
    scroll: remote('page.scroll'),
    back: remote('page.back'),
    forward: remote('page.forward'),
    reload: remote('page.reload'),
    waitFor: remote('page.waitFor'),
    evaluate: (fn, arg) => invoke('page.evaluate', [typeof fn === 'function' ? '(' + fn.toString() + ')(' + (arg === undefined ? '' : stringify(arg)) + ')' : fn])
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
let context = null
let current = null
const waiting = new Map()
process.on('unhandledRejection', () => {})
const send = (message) => {
  if (process.connected) process.send(message, () => {})
}
const call = (method, args, resolve, reject) => {
  if (current === null) return
  const id = ++sequence
  waiting.set(id, { resolve, reject })
  send({ type: 'call', run: current, id, method, args })
}
const log = (line) => {
  if (current === null || logLines >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) return
  const text = String(line).slice(0, MAX_LOG_CHARS - logChars)
  logLines += 1
  logChars += text.length
  send({ type: 'log', run: current, line: text })
}
const settle = (run, message) => {
  if (current !== run) return
  send({ ...message, run })
  current = null
  waiting.clear()
}
const finishError = (run, error) => {
  const code = error && typeof error.code === 'string' ? error.code : undefined
  settle(run, { type: 'failed', ...(code ? { code } : {}), message: error && typeof error.message === 'string' ? error.message : String(error) })
}
const finish = (run, value) => {
  let text
  try {
    text = JSON.stringify(value === undefined ? null : value)
  } catch {
    text = JSON.stringify(String(value))
  }
  settle(run, { type: 'done', result: text === undefined ? 'null' : text })
}
const run = (code, id) => {
  if (!context) {
    context = vm.createContext(Object.create(null))
    vm.runInContext(CONTEXT_SOURCE, context)(call, () => state, log)
  }
  current = id
  logLines = 0
  logChars = 0
  waiting.clear()
  let running
  try {
    running = vm.runInContext('(async () => {\n' + code + '\n})()', context, { timeout: 2000, filename: 'browser-script.js' })
  } catch (error) {
    finishError(id, error)
    return
  }
  Promise.resolve(running).then((value) => finish(id, value), (error) => finishError(id, error))
}
process.on('disconnect', () => process.exit(0))
process.on('message', (message) => {
  if (message.type === 'ping') send({ type: 'pong', id: message.id })
  else if (message.type === 'state') state = message.state
  else if (message.type === 'start') run(message.code, message.run)
  else if (message.type === 'end') {
    if (current === message.run) {
      current = null
      waiting.clear()
    }
  } else if (message.type === 'reply') {
    if (message.run !== current) return
    const entry = waiting.get(message.id)
    if (!entry) return
    waiting.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(message.code, message.message)
  }
})
send({ type: 'ready' })
`
