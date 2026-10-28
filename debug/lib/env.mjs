import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..', '..')
export const debugDir = join(root, 'debug')
export const dataDir = join(debugDir, 'data')
export const runsDir = join(debugDir, 'runs')
export const sessionSamplesDir = join(dataDir, 'sessions')
export const currentFile = join(runsDir, 'current.json')

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function newRunDir(label) {
  const dir = join(runsDir, `${stamp()}-${label}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const INHERITED_APP_ENV = /^(YAN_|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$|PI_CODING_AGENT_DIR$)/

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!INHERITED_APP_ENV.test(key)) env[key] = value
  return { ...env, ...extra }
}

export async function freePort() {
  for (;;) {
    const port = await anyFreePort()
    if (port >= 1000) return port
  }
}

function anyFreePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

export function parseArgs(argv, valueFlags = new Set()) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) flags[key] = inline
    else if (valueFlags.has(key) && argv[i + 1] !== undefined) flags[key] = argv[++i]
    else flags[key] = true
  }
  return { positional, flags }
}
