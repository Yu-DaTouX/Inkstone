import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StdioTreeClientTransport } from './stdio-tree-transport'
import { atomicWrite, nativeMcpTextFingerprint } from './config-write'

export interface StdioProbeConfig {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export type InstructionsProbe = (config: StdioProbeConfig) => Promise<string | undefined>

const INDIRECT_EXPOSURES = new Set(['codemode', 'deferred'])
const PROBE_TIMEOUT_MS = 15_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function literal(value: unknown): value is string {
  return typeof value === 'string' && !value.startsWith('!') && !value.includes('$')
}

export function describableStdioEntry(value: unknown, fallbackCwd: string = homedir()): StdioProbeConfig | null {
  const entry = asRecord(value)
  if (!entry || entry.description !== undefined || entry.enabled === false) return null
  if (entry.url !== undefined || (entry.type !== undefined && entry.type !== 'stdio')) return null
  if (!literal(entry.command) || !entry.command.trim()) return null
  const exposures = [entry.exposure ?? 'codemode', ...Object.values(asRecord(entry.toolExposure) ?? {})]
  if (!exposures.some((exposure) => typeof exposure === 'string' && INDIRECT_EXPOSURES.has(exposure))) return null
  const args = entry.args ?? []
  if (!Array.isArray(args) || !args.every(literal)) return null
  const env = asRecord(entry.env ?? {})
  if (!env || !Object.values(env).every(literal)) return null
  if (entry.cwd !== undefined && !literal(entry.cwd)) return null
  return { command: entry.command, args, env: env as Record<string, string>, cwd: typeof entry.cwd === 'string' ? entry.cwd : fallbackCwd }
}

export function instructionSummary(instructions: string | undefined): string {
  return (instructions ?? '').split('\n', 1)[0].trim()
}

export async function probeStdioInstructions(config: StdioProbeConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  const transport = new StdioTreeClientTransport({ command: config.command, args: config.args, env: { ...getDefaultEnvironment(), ...config.env }, cwd: config.cwd, stderr: 'ignore' })
  const client = new Client({ name: 'yan', version: '0.2.0' }, { capabilities: {} })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP instructions probe timed out')), timeoutMs) })
    ])
    return client.getInstructions()
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

const PROBE_FAILURE_RETRY_MS = 24 * 60 * 60_000

interface ProbeCacheEntry {
  fingerprint: string
  at: number
  summary?: string
  failed?: boolean
}

export interface NativeDescribeOptions {
  cachePath?: string
  now?: () => number
}

export function probeFingerprint(config: StdioProbeConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([config.command, config.args, Object.entries(config.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), config.cwd]))
    .digest('hex')
}

async function loadProbeCache(path: string | undefined): Promise<Record<string, ProbeCacheEntry>> {
  if (!path) return {}
  try {
    const parsed = asRecord(JSON.parse(await readFile(path, 'utf8')))
    const entries = asRecord(parsed?.entries) ?? {}
    const cache: Record<string, ProbeCacheEntry> = {}
    for (const [name, value] of Object.entries(entries)) {
      const entry = asRecord(value)
      if (!entry || typeof entry.fingerprint !== 'string' || typeof entry.at !== 'number') continue
      cache[name] = {
        fingerprint: entry.fingerprint,
        at: entry.at,
        ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {}),
        ...(entry.failed === true ? { failed: true } : {})
      }
    }
    return cache
  } catch {
    return {}
  }
}

async function saveProbeCache(path: string | undefined, cache: Record<string, ProbeCacheEntry>): Promise<void> {
  if (!path) return
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, `${JSON.stringify({ version: 1, entries: cache })}\n`, 'utf8')
  await rename(temp, path)
}

export async function fillNativeMcpDescriptions(
  path: string,
  probe: InstructionsProbe = probeStdioInstructions,
  options: NativeDescribeOptions = {}
): Promise<string[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const root = asRecord(JSON.parse(text))
  const servers = asRecord(root?.mcpServers)
  if (!root || !servers) return []
  const now = options.now ?? Date.now
  const previous = await loadProbeCache(options.cachePath)
  const cache: Record<string, ProbeCacheEntry> = {}
  const found = new Map<string, string>()
  for (const [name, entry] of Object.entries(servers)) {
    const config = describableStdioEntry(entry)
    if (!config) continue
    const fingerprint = probeFingerprint(config)
    const cached = previous[name]
    if (cached && cached.fingerprint === fingerprint && (!cached.failed || now() - cached.at < PROBE_FAILURE_RETRY_MS)) {
      cache[name] = cached
      if (cached.summary) found.set(name, cached.summary)
      continue
    }
    let summary = ''
    let failed = false
    try {
      summary = instructionSummary(await probe(config))
    } catch {
      failed = true
    }
    cache[name] = { fingerprint, at: now(), ...(summary ? { summary } : {}), ...(failed ? { failed: true } : {}) }
    if (summary) found.set(name, summary)
  }
  await saveProbeCache(options.cachePath, cache).catch(() => undefined)
  if (found.size === 0) return []
  for (const [name, summary] of found) (servers[name] as Record<string, unknown>).description = summary
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] || '  '
  await atomicWrite(path, `${JSON.stringify(root, null, indent)}\n`, nativeMcpTextFingerprint(text))
  return [...found.keys()]
}
