import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { cleanEnv, root, sleep } from './env.mjs'

const require = createRequire(join(root, 'package.json'))
export const holdProbe = join(import.meta.dirname, 'hold.js')

export function builtAppAge() {
  const main = join(root, 'out', 'main', 'index.js')
  return existsSync(main) ? Date.now() - statSync(main).mtimeMs : null
}

export function buildApp() {
  const result = spawnSync(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, stdio: 'inherit', env: cleanEnv() })
  if (result.status !== 0) throw new Error('electron-vite build 失败')
}

export function launchApp(env, { dev = false, inherit = false } = {}) {
  const fullEnv = cleanEnv(env)
  const child = dev
    ? spawn(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev'], { cwd: root, env: fullEnv, stdio: inherit ? 'inherit' : 'pipe', windowsHide: true })
    : spawn(require('electron'), ['.'], { cwd: root, env: fullEnv, stdio: inherit ? 'inherit' : 'pipe', windowsHide: true })
  let log = ''
  child.stdout?.on('data', (chunk) => { log += chunk })
  child.stderr?.on('data', (chunk) => { log += chunk })
  return { child, log: () => log }
}

export function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}

export function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function connectCdp(port, { shotDir, timeoutMs = 60000 } = {}) {
  let target
  const end = Date.now() + timeoutMs
  while (!target && Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      target = list.find((entry) => entry.type === 'page' && !entry.url.startsWith('devtools'))
    } catch {}
    if (!target) await sleep(300)
  }
  if (!target) throw new Error(`CDP ${port} 上找不到渲染页`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
  let seq = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) } else events.push(data)
  }
  const call = (method, params = {}) => new Promise((done) => { const id = ++seq; pending.set(id, done); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text)
    return res.result?.result?.value
  }
  const shot = async (name, dir = shotDir) => {
    const res = await call('Page.captureScreenshot', { format: 'png' })
    const file = join(dir, name.endsWith('.png') ? name : `${name}.png`)
    writeFileSync(file, Buffer.from(res.result.data, 'base64'))
    return file
  }
  await call('Runtime.enable')
  await call('Page.enable')
  return { call, evaluate, shot, events, close: () => ws.close() }
}

export function storeHelpers(cdp) {
  const state = (expr) => cdp.evaluate(`(() => { const s = window.__yanStore.getState(); return ${expr} })()`)
  const until = async (expr, timeout = 20000, step = 50) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await state(expr).catch(() => false)) return true
      await sleep(step)
    }
    return false
  }
  return { state, until }
}
