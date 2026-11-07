import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comfyStatus, ensureComfyRunning, holdManagedComfy, stopManagedComfy } from '../integrations/comfyui/launcher.mjs'

const FAKE_SERVER = `
const { createServer } = require('node:http')
const { existsSync } = require('node:fs')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/system_stats') return res.end('{"system":{}}')
  if (req.url === '/queue') return res.end(JSON.stringify({ queue_running: existsSync('busy') ? [[1]] : [], queue_pending: [] }))
  res.statusCode = 404
  res.end('{}')
}).listen(port, '127.0.0.1')
`

const realFetch = globalThis.fetch
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function alive(baseUrl) {
  try { return (await realFetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}

export async function runComfyIdleTests() {
  const dir = await mkdtemp(join(tmpdir(), 'yan-comfy-idle-'))
  const currentFetch = globalThis.fetch
  const oldEnv = { ...process.env }
  globalThis.fetch = realFetch
  let checks = 0
  try {
    await writeFile(join(dir, 'main.py'), FAKE_SERVER)
    await mkdir(join(dir, 'user'))
    await writeFile(join(dir, 'busy'), '')
    process.env.YAN_COMFYUI_DIR = dir
    process.env.YAN_COMFYUI_PYTHON = process.execPath
    process.env.YAN_COMFYUI_IDLE_MINUTES = '0.01'
    process.env.YAN_COMFYUI_START_SECONDS = '30'
    await comfyStatus()
    const server = await ensureComfyRunning()
    const hold = holdManagedComfy(server.baseUrl)
    if (!hold.managed) {
      console.log('comfyui-idle: skipped (another ComfyUI is already running on this machine)')
      return 0
    }
    hold.release()
    await wait(2500)
    assert.equal(await alive(server.baseUrl), true, 'queued work keeps managed ComfyUI alive past the idle limit')
    checks++
    await rm(join(dir, 'busy'))
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && await alive(server.baseUrl)) await wait(200)
    assert.equal(await alive(server.baseUrl), false, 'empty queue lets the idle timer stop managed ComfyUI')
    checks++
    return checks
  } finally {
    stopManagedComfy()
    globalThis.fetch = currentFetch
    for (const name of Object.keys(process.env)) if (name.startsWith('YAN_COMFYUI_')) delete process.env[name]
    for (const [name, value] of Object.entries(oldEnv)) if (name.startsWith('YAN_COMFYUI_')) process.env[name] = value
    await wait(500)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}
