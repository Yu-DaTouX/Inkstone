import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface McpNativeSourceSnapshot {
  path: string
  present: boolean
  hash: string
  servers: readonly string[]
}

export interface McpNativeBootWitness {
  readonly bootId: string
  readonly generation: number
  readonly cwd: string
  readonly projectId: string | null
  readonly capturedAt: string
  readonly sources: readonly McpNativeSourceSnapshot[]
  readonly servers: readonly string[]
}

export function nativeWitnessPaths(agentDir: string, cwd: string): string[] {
  return [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]
}

export function newBootId(): string {
  return randomBytes(16).toString('hex')
}

export type McpNativeConfigReader = (path: string) => Promise<string | null>

export async function defaultNativeConfigReader(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface SourceRead {
  ok: true
  source: McpNativeSourceSnapshot
}
interface SourceReadFailure {
  ok: false
  reason: string
}
type SourceReadResult = SourceRead | SourceReadFailure

async function readSource(path: string, readNativeConfig?: McpNativeConfigReader): Promise<SourceReadResult> {
  let text: string | null
  try {
    text = readNativeConfig ? await readNativeConfig(path) : await defaultNativeConfigReader(path)
  } catch (error) {
    return { ok: false, reason: `无法读取 pi 原生配置 ${path}：${messageOf(error)}` }
  }
  if (text === null) {
    return { ok: true, source: { path, present: false, hash: '', servers: [] } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `pi 原生配置不是合法 JSON（${path}）：${messageOf(error)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: `pi 原生配置顶层不是对象（${path}），拒绝签发启动见证` }
  }
  const rawServers = (parsed as Record<string, unknown>).mcpServers
  if (rawServers !== undefined && rawServers !== null) {
    if (typeof rawServers !== 'object' || Array.isArray(rawServers)) {
      return { ok: false, reason: `pi 原生配置的 mcpServers 形状不对（${path}），拒绝签发启动见证` }
    }
  }
  const servers =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? Object.keys(rawServers as Record<string, unknown>).sort()
      : []
  return { ok: true, source: { path, present: true, hash: hashText(text), servers } }
}

export interface McpNativeCaptureOptions {
  agentDir: string
  cwd: string
  bootId: string
  generation: number
  projectId?: string | null
  readNativeConfig?: McpNativeConfigReader
  now?: () => number
}

export interface McpNativeCaptureResult {
  ok: boolean
  witness?: McpNativeBootWitness
  reason?: string
}

export async function captureNativeStartupWitness(
  options: McpNativeCaptureOptions
): Promise<McpNativeCaptureResult> {
  const agentDir = typeof options.agentDir === 'string' ? options.agentDir.trim() : ''
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : ''
  if (!agentDir) return { ok: false, reason: '缺少 pi agent 目录，无法采集原生配置启动见证' }
  if (!cwd) return { ok: false, reason: '缺少 runner 工作目录，无法采集原生配置启动见证' }
  if (!options.bootId) return { ok: false, reason: '缺少 bootId，拒绝签发启动见证' }

  const sources: McpNativeSourceSnapshot[] = []
  for (const path of nativeWitnessPaths(agentDir, cwd)) {
    const read = await readSource(path, options.readNativeConfig)
    if (!read.ok) return { ok: false, reason: read.reason }
    sources.push(read.source)
  }
  const servers = [...new Set(sources.flatMap((source) => source.servers))].sort()
  return {
    ok: true,
    witness: {
      bootId: options.bootId,
      generation: options.generation,
      cwd,
      projectId: options.projectId ?? null,
      capturedAt: new Date((options.now ?? Date.now)()).toISOString(),
      sources,
      servers
    }
  }
}

export interface McpNativeVerifyOptions {
  readNativeConfig?: McpNativeConfigReader
}

export async function verifyNativeStartupWitness(
  witness: McpNativeBootWitness,
  options: McpNativeVerifyOptions = {}
): Promise<{ ok: boolean; reason?: string }> {
  if (!witness || typeof witness !== 'object' || !witness.bootId || !Array.isArray(witness.sources)) {
    return { ok: false, reason: '启动见证形状不对，无法核对' }
  }
  for (const source of witness.sources) {
    const read = await readSource(source.path, options.readNativeConfig)
    if (!read.ok) return { ok: false, reason: read.reason }
    if (read.source.present !== source.present || read.source.hash !== source.hash) {
      return { ok: false, reason: `pi 原生配置 ${source.path} 在启动见证之后发生了变化` }
    }
  }
  return { ok: true }
}

function canonicalCwd(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function nativeWitnessIdentityMatches(
  witness: McpNativeBootWitness | null | undefined,
  identity: { generation: number; cwd: string }
): boolean {
  if (!witness || typeof witness.bootId !== 'string' || witness.bootId.length === 0) return false
  if (!Number.isSafeInteger(witness.generation) || witness.generation !== identity.generation) return false
  if (typeof witness.cwd !== 'string' || !witness.cwd.trim()) return false
  return canonicalCwd(witness.cwd) === canonicalCwd(identity.cwd)
}
