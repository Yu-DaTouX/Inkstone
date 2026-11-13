import { setUiLang } from '../shared/ui-lang'
import { runGitReadOp } from './git-read-ops'
import type { GitReadRequest } from './git-read-ops'
import type { AuthorizeReadCwd } from './git-inspect'

interface ReadMessage {
  kind: 'read'
  id: string
  request: GitReadRequest
  env: Record<string, string>
  lang: string
}

interface AuthorizedMessage {
  kind: 'authorized'
  id: string
  key: string
  value?: unknown
  failed?: boolean
  error?: string
}

const port = process.parentPort
const waits = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let seq = 0

function applyEnv(env: Record<string, string>): void {
  if (!env || typeof env !== 'object') return
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && process.env[key] !== value) process.env[key] = value
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reply(message: Record<string, unknown>): void {
  try {
    port.postMessage(message)
  } catch (error) {
    port.postMessage({ id: message.id, failed: true, error: errorText(error) })
  }
}

function onAuthorized(message: AuthorizedMessage): void {
  const wait = waits.get(message.key)
  if (!wait) return
  waits.delete(message.key)
  if (message.failed === true) wait.reject(new Error(String(message.error ?? '')))
  else wait.resolve(message.value)
}

function onRead(message: ReadMessage): void {
  applyEnv(message.env)
  setUiLang(message.lang)
  const id = message.id
  const authorize: AuthorizeReadCwd = (cwd) =>
    new Promise((resolve, reject) => {
      seq += 1
      const key = `${id}:${seq}`
      waits.set(key, { resolve: resolve as (value: unknown) => void, reject })
      port.postMessage({ id, authorize: { key, cwd } })
    })
  void runGitReadOp(message.request, authorize).then(
    (value) => reply({ id, value }),
    (error: unknown) => reply({ id, failed: true, error: errorText(error) })
  )
}

port.on('message', (event: { data: unknown }) => {
  const message = event.data as ReadMessage | AuthorizedMessage | null
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return
  if (message.kind === 'authorized') onAuthorized(message)
  else if (message.kind === 'read') onRead(message)
})
