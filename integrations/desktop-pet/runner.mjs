import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.env.YAN_PET_ENTRY
const dshHome = process.env.DSH_HOME
if (!entry || !dshHome || typeof process.send !== 'function') {
  console.error('[pet-runner] missing YAN_PET_ENTRY / DSH_HOME / IPC channel')
  process.exit(2)
}

const shimUrls = {
  '@deepseek-ai/dsh-home-paths': new URL('./shims/dsh-home-paths.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-credentials': new URL('./shims/dsh-credentials.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-llm': new URL('./shims/dsh-llm.mjs', import.meta.url).href
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const shim = shimUrls[specifier]
    if (shim) return { url: shim, format: 'module', shortCircuit: true }
    return nextResolve(specifier, context)
  }
})

delete process.versions.electron

const OPEN_APP_PATH = '/inkstone/open'

let modelEnabled = process.env.YAN_PET_MODEL === '1'
let modelLabel = process.env.YAN_PET_MODEL_LABEL || ''
let shuttingDown = false
let llmSeq = 0
const llmPending = new Map()
const listeners = new Map()
const disposers = []
const routes = []

function send(message) {
  try {
    if (process.connected) process.send(message)
  } catch {
  }
}

const logger = {
  info: (message) => console.log(`[pet] ${message}`),
  warn: (message) => console.warn(`[pet] ${message}`),
  error: (message) => console.error(`[pet] ${message}`),
  debug: () => {}
}

function seedUserConfig() {
  const dir = join(dshHome, 'dsh-pet')
  const file = join(dir, 'main-config.jsonc')
  if (existsSync(file) || existsSync(join(dir, 'main-config.json'))) return
  mkdirSync(dir, { recursive: true })
  const config = {
    pets: [
      {
        name: '蓝毛小女仆',
        id: 'main',
        size: 462,
        balanceEnabled: false,
        whisperEnabled: true,
        workStatusEnabled: true,
        fixedEnabled: false,
        display: 'desktop',
        position: { corner: 'top-right', marginX: 24, marginY: 100 }
      }
    ]
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function requestCompletion(options) {
  if (!modelEnabled) return Promise.reject(new Error('桌宠模型未在 Inkstone 中开启'))
  const id = ++llmSeq
  const messages = (Array.isArray(options?.messages) ? options.messages : []).map((message) => ({
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    text: textOf(message?.content)
  }))
  return new Promise((resolve, reject) => {
    const signal = options?.signal
    const onAbort = () => {
      llmPending.delete(id)
      send({ type: 'llm-cancel', id })
      reject(new Error('生成已取消'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    llmPending.set(id, {
      resolve: (text) => {
        signal?.removeEventListener?.('abort', onAbort)
        resolve(text)
      },
      reject: (error) => {
        signal?.removeEventListener?.('abort', onAbort)
        reject(error)
      }
    })
    send({ type: 'llm', id, system: typeof options?.system === 'string' ? options.system : '', messages })
  })
}

const llm = {
  listProviders: () => (modelEnabled ? [{ id: 'inkstone', name: 'Inkstone' }] : []),
  listModels: async (provider) => (modelEnabled && provider === 'inkstone' ? [{ id: 'pet', name: modelLabel || 'Inkstone' }] : []),
  resolveModelInfo: async () => undefined,
  stream(options) {
    let finished = false
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (finished) return { done: true, value: undefined }
            finished = true
            const text = await requestCompletion(options)
            return { done: false, value: { type: 'text', text } }
          }
        }
      }
    }
  }
}

const server = createServer((req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      return '/'
    }
  })()
  if (pathname === OPEN_APP_PATH || pathname === `${OPEN_APP_PATH}/`) {
    send({ type: 'open-app' })
    const body = '<!doctype html><meta charset="utf-8"><title>Inkstone</title><p>已切回 Inkstone，可以关闭此页。</p>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }
  const route = routes.find((item) =>
    item.kind === 'exact' ? pathname === item.path : pathname === item.path || pathname.startsWith(`${item.path}/`))
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((error) => {
      logger.error(`route ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      }
    })
})
server.on('clientError', (_error, socket) => socket.destroy())

let port = 0
const ctx = {
  effect(fn) {
    try {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    } catch (error) {
      logger.error(`effect failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  },
  on(name, handler) {
    const set = listeners.get(name) ?? new Set()
    set.add(handler)
    listeners.set(name, set)
    return () => set.delete(handler)
  },
  get: () => undefined,
  logger,
  webServer: {
    get port() {
      return port
    },
    register(spec) {
      const route = { kind: spec.kind, path: spec.path, handler: spec.handler }
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    }
  },
  connection: { authenticatedUrl: (origin) => `${origin}${OPEN_APP_PATH}` },
  commands: { register: () => () => {} },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'inkstone', model: modelEnabled ? 'pet' : '' })
  },
  credentials: { resolve: async () => undefined },
  llm
}

function emit(name, ...args) {
  for (const handler of listeners.get(name) ?? []) {
    try {
      handler(...args)
    } catch (error) {
      logger.warn(`${name} handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const pending of llmPending.values()) pending.reject(new Error('桌宠已停止'))
  llmPending.clear()
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      await dispose()
    } catch (error) {
      logger.warn(`dispose failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(() => resolve()))
  process.exit(code)
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'event') emit('session/event', message.session, message.event)
  else if (message.type === 'model') {
    modelEnabled = message.enabled === true
    modelLabel = typeof message.label === 'string' ? message.label : ''
  } else if (message.type === 'llm-result') {
    const pending = llmPending.get(message.id)
    if (!pending) return
    llmPending.delete(message.id)
    if (typeof message.text === 'string' && message.text) pending.resolve(message.text)
    else pending.reject(new Error(typeof message.error === 'string' && message.error ? message.error : '模型未返回文本'))
  } else if (message.type === 'stop') void shutdown(0)
})
process.on('disconnect', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
process.on('unhandledRejection', (error) => logger.error(`unhandled: ${error instanceof Error ? error.message : String(error)}`))

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = server.address().port
  seedUserConfig()
  const plugin = await import(pathToFileURL(entry).href)
  if (typeof plugin.apply !== 'function') throw new Error('dsh-pet entry has no apply()')
  await plugin.apply(ctx, {})
  send({ type: 'ready', port })
  logger.info(`host ready on http://127.0.0.1:${port}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`start failed: ${message}`)
  send({ type: 'failed', message })
  await shutdown(1)
}
