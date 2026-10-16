/**
 * pi 原生 MCP 配置的**启动见证**（native boot witness）。
 *
 * ── 它回答什么问题 ──
 *   「这个存活的 pi 进程，在**它启动的那一刻**有没有加载目标 MCP 服务？」
 *   配置文件现在没有该条目，不能证明进程启动时也没有 —— 外部可能在这中间
 *   改过文件、或进程用的是更早的那份快照。反过来，也不能拿
 *   `appHost.at` / `managedAt` 之类的时间戳去猜：「托管声明写盘」与「runner 启动」
 *   谁先谁后没有可靠顺序（at 可能早于两文件写盘）。
 *
 *   唯一的可靠证据是：进程 spawn 前记下真实配置源的 serverId 集合与文本 hash，
 *   pi ready 后重读并逐一比对；只有**两次完全一致**才签发一个带随机 bootId 的
 *   不可变见证。之后核对该见证时再重读一次，任何变化/读失败/坏 JSON 都视为
 *   「无法证明」→ 该 runner 按可能持有处理（fail-closed）。
 *
 * ── 安全边界 ──
 *   · 见证只保存 serverId 集合与整文件 SHA256，**不保存凭据、原文或环境变量**；
 *   · bootId 由宿主随机生成，仅存在于 AgentController 内部，renderer / RPC 不能
 *     传入或替换；
 *   · 本模块不做任何落盘、不启动进程、不连接服务，只读写给定路径的文本。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 单个原生配置源在启动时的只读快照（无凭据、无原文）。 */
export interface McpNativeSourceSnapshot {
  path: string
  /** 文件是否存在；不存在时 hash 为空串。 */
  present: boolean
  /** 整文件文本的 SHA256；文件不存在时为 `''`。 */
  hash: string
  /** `mcpServers` 的键集合（已排序），不含任何值 / env。 */
  servers: readonly string[]
}

/** 一次 pi 进程启动的不可变见证。 */
export interface McpNativeBootWitness {
  /** 宿主生成的随机启动标识；renderer / RPC 无法自报。 */
  readonly bootId: string
  /** 捕获时的 runner generation。 */
  readonly generation: number
  readonly cwd: string
  readonly projectId: string | null
  /** 捕获时间（仅用于诊断，不参与任何放行判定）。 */
  readonly capturedAt: string
  readonly sources: readonly McpNativeSourceSnapshot[]
  /** 所有源 serverId 的并集。 */
  readonly servers: readonly string[]
}

/** 只读路径来源：全局 `PI_AGENT_DIR/mcp.json` + 本 cwd 项目 `.pi/mcp.json`。 */
export function nativeWitnessPaths(agentDir: string, cwd: string): string[] {
  return [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]
}

export function newBootId(): string {
  return randomBytes(16).toString('hex')
}

export type McpNativeConfigReader = (path: string) => Promise<string | null>

/** 缺省 fs 读：只把 ENOENT 当「文件不存在」，其余读失败照实返回错误。 */
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

/** 读一个原生配置源；形状不认识按失败处理（宁可不签发，也不猜）。 */
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

/**
 * spawn 前捕获：读全局 + 本 cwd 项目原生配置，记下 serverId 集合与文本 hash。
 * 任一源读失败 / 坏 JSON / 缺 agentDir 都不签发（返回 `ok:false`）。
 */
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

/**
 * pi ready 后 / 每次核对持有者时重读：必须与捕获时**逐一完全相同**。
 * 任何读失败、坏 JSON、文件增删或内容 hash 变化都返回 `ok:false`。
 */
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

/**
 * 见证是否属于**当前这个** runner 进程身份：bootId 非空、generation 一致、cwd 一致。
 * 不一致即无法证明，调用方按「可能持有」处理。
 */
export function nativeWitnessIdentityMatches(
  witness: McpNativeBootWitness | null | undefined,
  identity: { generation: number; cwd: string }
): boolean {
  if (!witness || typeof witness.bootId !== 'string' || witness.bootId.length === 0) return false
  if (!Number.isSafeInteger(witness.generation) || witness.generation !== identity.generation) return false
  if (typeof witness.cwd !== 'string' || !witness.cwd.trim()) return false
  return canonicalCwd(witness.cwd) === canonicalCwd(identity.cwd)
}
