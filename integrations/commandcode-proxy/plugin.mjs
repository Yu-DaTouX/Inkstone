import { createServer } from 'node:net'
import { get } from 'node:http'

const HOST = '127.0.0.1'
const requested = Number(process.env.YAN_COMMANDCODE_PROXY_PORT)
const PORT = Number.isInteger(requested) && requested > 0 && requested < 65536 ? requested : 3050
const state = { running: false, url: `http://${HOST}:${PORT}/v1`, port: PORT, error: '' }

function portFree() {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', error => resolve(error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，可用环境变量 YAN_COMMANDCODE_PROXY_PORT 换端口` : String(error.message ?? error)))
    probe.once('listening', () => probe.close(() => resolve('')))
    probe.listen(PORT, HOST)
  })
}

function healthy() {
  return new Promise(resolve => {
    const req = get({ host: HOST, port: PORT, path: '/health', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200) })
    req.once('timeout', () => req.destroy())
    req.once('error', () => resolve(false))
  })
}

async function start() {
  state.error = await portFree()
  if (state.error) return
  process.env.PORT = String(PORT)
  process.env.HOST = HOST
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  if (proxy && /^http:\/\//i.test(proxy) && !process.env.CC_UPSTREAM_PROXY) process.env.CC_UPSTREAM_PROXY = proxy
  await import('./proxy.mjs')
  for (let i = 0; i < 50 && !state.running; i++) {
    state.running = await healthy()
    if (!state.running) await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!state.running) state.error = '代理未能在 5 秒内就绪'
}

const actions = {
  status: async () => {
    if (state.running) state.running = await healthy()
    return { ...state }
  }
}

process.on('message', message => {
  if (message?.type !== 'request') return
  const action = Object.hasOwn(actions, message.action) ? actions[message.action] : undefined
  void Promise.resolve()
    .then(() => {
      if (!action) throw new Error('未知插件操作')
      return action(message.params)
    })
    .then(
      value => { if (process.connected) process.send?.({ type: 'response', id: message.id, value }) },
      error => { if (process.connected) process.send?.({ type: 'response', id: message.id, error: String(error?.message ?? error) }) }
    )
})
process.on('disconnect', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
await start().catch(error => { state.error = String(error?.message ?? error) })
process.send?.({ type: 'ready' })
