import { execFile } from 'node:child_process'
import { get as httpGet } from 'node:http'
import type { LocalServerInfo } from '../../shared/local-servers'

export interface LocalServerListener {
  host: string
  port: number
  pid?: number
  processName?: string
}

export interface ListenEndpoint {
  host: string
  port: number
}

const LOCAL_LISTEN_HOSTS = new Set(['127.0.0.1', '0.0.0.0', '::1', '::'])
const USER_PORT_MIN = 1024
const USER_PORT_MAX = 65535
const PROBE_TIMEOUT_MS = 800
const PROBE_CONCURRENCY = 8
const PROBE_BODY_LIMIT = 64 * 1024
const TITLE_LIMIT = 160
const EXEC_TIMEOUT_MS = 5000
const EXEC_MAX_BUFFER = 16 * 1024 * 1024
const CACHE_TTL_MS = 3000

const SYSTEM_PROCESS_NAMES = new Set([
  'system',
  'system idle process',
  'idle',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'svchost',
  'spoolsv',
  'fontdrvhost',
  'dwm',
  'sihost',
  'ctfmon',
  'taskhostw',
  'runtimebroker',
  'searchindexer',
  'searchprotocolhost',
  'searchfilterhost',
  'mdnsresponder'
])

function normalizeHost(raw: string): string {
  const host = raw.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return host === '' || host === '*' ? '0.0.0.0' : host
}

export function isLocalListenHost(host: string): boolean {
  return LOCAL_LISTEN_HOSTS.has(normalizeHost(host))
}

function isUserPort(port: number): boolean {
  return Number.isInteger(port) && port >= USER_PORT_MIN && port <= USER_PORT_MAX
}

export function parseListenEndpoint(raw: string): ListenEndpoint | null {
  const value = raw.trim()
  const index = value.lastIndexOf(':')
  if (index <= 0 || index === value.length - 1) return null
  const host = normalizeHost(value.slice(0, index))
  const portText = value.slice(index + 1)
  if (!host || !/^\d+$/.test(portText)) return null
  const port = Number.parseInt(portText, 10)
  if (!isUserPort(port)) return null
  return { host, port }
}

export function parseNetstatListening(output: string): LocalServerListener[] {
  const listeners: LocalServerListener[] = []
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/)
    if (cells.length < 5 || !/^TCP/i.test(cells[0])) continue
    if (cells[3].toUpperCase() !== 'LISTENING') continue
    const endpoint = parseListenEndpoint(cells[1])
    if (!endpoint || !isLocalListenHost(endpoint.host)) continue
    const pid = Number.parseInt(cells[4], 10)
    listeners.push({ host: endpoint.host, port: endpoint.port, pid: Number.isInteger(pid) ? pid : undefined })
  }
  return listeners
}

export function parseLsofListening(output: string): LocalServerListener[] {
  const listeners: LocalServerListener[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('COMMAND')) continue
    const cells = trimmed.split(/\s+/)
    if (cells.length < 5) continue
    const endpoint = cells
      .slice(3)
      .map(parseListenEndpoint)
      .find((value): value is ListenEndpoint => value !== null && isLocalListenHost(value.host))
    if (!endpoint) continue
    const pid = Number.parseInt(cells[1], 10)
    listeners.push({
      host: endpoint.host,
      port: endpoint.port,
      pid: Number.isInteger(pid) ? pid : undefined,
      processName: cells[0]
    })
  }
  return listeners
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          value += '"'
          i += 1
        } else quoted = false
      } else value += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      cells.push(value)
      value = ''
    } else value += ch
  }
  if (value !== '' || cells.length > 0) cells.push(value)
  return cells
}

export function parseWindowsTasklist(output: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (cells.length < 2) continue
    const pid = Number.parseInt(cells[1], 10)
    if (!Number.isInteger(pid)) continue
    names.set(pid, cells[0].replace(/\.exe$/i, ''))
  }
  return names
}

export function isSystemProcessName(name: string | undefined): boolean {
  return name ? SYSTEM_PROCESS_NAMES.has(name.trim().toLowerCase()) : false
}

export function attachProcessNames(
  listeners: readonly LocalServerListener[],
  names: ReadonlyMap<number, string>
): LocalServerListener[] {
  return listeners.map((listener) =>
    listener.pid === undefined ? listener : { ...listener, processName: names.get(listener.pid) }
  )
}

export function selectLocalServers(
  listeners: readonly LocalServerListener[],
  selfPid: number
): LocalServerListener[] {
  const seenPorts = new Set<number>()
  const selected: LocalServerListener[] = []
  for (const listener of [...listeners].sort((a, b) => a.port - b.port)) {
    if (listener.pid !== undefined && listener.pid === selfPid) continue
    if (isSystemProcessName(listener.processName)) continue
    if (seenPorts.has(listener.port)) continue
    seenPorts.add(listener.port)
    selected.push(listener)
  }
  return selected
}

function fromCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

export function parseHtmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return undefined
  const title = decodeEntities(match[1].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return title ? title.slice(0, TITLE_LIMIT) : undefined
}

function probeHttp(port: number): Promise<{ title?: string } | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: { title?: string } | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = httpGet(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        timeout: PROBE_TIMEOUT_MS,
        headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
      },
      (response) => {
        const contentType = String(response.headers['content-type'] ?? '')
        if (!/html/i.test(contentType)) {
          response.resume()
          finish(null)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          if (settled) return
          body += chunk
          if (body.length >= PROBE_BODY_LIMIT) {
            response.destroy()
            finish({ title: parseHtmlTitle(body.slice(0, PROBE_BODY_LIMIT)) })
          }
        })
        response.on('end', () => finish({ title: parseHtmlTitle(body) }))
        response.on('close', () => finish({ title: parseHtmlTitle(body) }))
        response.on('error', () => finish({}))
      }
    )
    request.on('timeout', () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
  })
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true },
      (error, stdout) => resolve(error ? '' : String(stdout))
    )
  })
}

async function readListeners(): Promise<LocalServerListener[]> {
  if (process.platform === 'win32') {
    const [netstat, tasklist] = await Promise.all([
      runCommand('netstat', ['-ano', '-p', 'TCP']),
      runCommand('tasklist', ['/FO', 'CSV', '/NH'])
    ])
    return attachProcessNames(parseNetstatListening(netstat), parseWindowsTasklist(tasklist))
  }
  const lsof = await runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  return parseLsofListening(lsof)
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function collectLocalServers(): Promise<LocalServerInfo[]> {
  const candidates = selectLocalServers(await readListeners(), process.pid)
  const probed = await mapLimit<LocalServerListener, LocalServerInfo | null>(
    candidates,
    PROBE_CONCURRENCY,
    async (listener) => {
      const probe = await probeHttp(listener.port)
      if (!probe) return null
      const server: LocalServerInfo = {
        url: `http://127.0.0.1:${listener.port}`,
        port: listener.port,
        host: listener.host,
        pid: listener.pid,
        processName: listener.processName,
        title: probe.title
      }
      return server
    }
  )
  return rankLocalServers(probed.filter((server): server is LocalServerInfo => server !== null))
}

const DEV_RUNTIMES = /^(node|bun|deno|python\d*|pythonw|java|ruby|php|go|dotnet|cargo|uvicorn|gunicorn|hugo|caddy|nginx|httpd|esbuild|vite)(\.exe)?$/i
const APP_SHELLS = /^(electron|msedgewebview2|chrome|msedge|firefox|code|cursor)(\.exe)?$/i
const DEBUG_TITLES = /remote debugging|devtools|content shell/i

export function rankLocalServers(servers: readonly LocalServerInfo[]): LocalServerInfo[] {
  const devRank = (server: LocalServerInfo): number => (server.processName && DEV_RUNTIMES.test(server.processName) ? 0 : 1)
  return servers
    .filter((server) => !(server.processName && APP_SHELLS.test(server.processName)))
    .filter((server) => !(server.title && DEBUG_TITLES.test(server.title)))
    .sort((a, b) => devRank(a) - devRank(b) || (a.title ? 0 : 1) - (b.title ? 0 : 1) || a.port - b.port)
}

let cachedServers: LocalServerInfo[] = []
let cachedAt = 0
let pending: Promise<LocalServerInfo[]> | null = null

export function listLocalServers(): Promise<LocalServerInfo[]> {
  if (Date.now() - cachedAt < CACHE_TTL_MS) return Promise.resolve(cachedServers)
  if (pending) return pending
  pending = collectLocalServers()
    .then((servers) => {
      cachedServers = servers
      cachedAt = Date.now()
      pending = null
      return servers
    })
    .catch(() => {
      pending = null
      return cachedServers
    })
  return pending
}
