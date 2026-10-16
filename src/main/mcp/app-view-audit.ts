/**
 * App 调用审计的**持久化**存储（A6）。
 *
 * ── 为什么单独落盘 ──
 *   App 视图发起的 `tools/call` 不进 pi 的模型会话历史（它不是模型循环里的工具调用），
 *   但用户必须在步骤里看到「哪个 App 请求调用了什么、是被允许还是拒绝」。这里用一条
 *   独立的、受控的 append-only JSONL 记录这些事实，**绝不**直接写 pi 会话 JSONL
 *   （那份文件由 pi 自己维护，混写会破坏历史解析）。
 *
 * ── 边界 ──
 *   · 只保存安全摘要：id / 时间 / callId / 工具名 / 阶段 / 权限档 / 摘要文本 /
 *     `argsHash`（规范参数的 sha256）。**不保存**完整 args、原始 `_meta`、
 *     `structuredContent`、凭据或 token。
 *   · 每个会话文件一个 JSONL：`<YAN_DIR>/mcp-app/audit/<sha256(sessionFile)>.jsonl`，
 *     目录由宿主编排，渲染端无法指定。
 *   · 写入失败直接抛出 —— 调用方按 fail-closed 处理：审计没落库就**不执行**工具
 *     （`all` 档同样如此）。
 *   · 单文件大小有界：超过上限先把旧文件轮转为 `.1` 再写新文件，绝不无限增长。
 *   · 读取时坏行跳过，按 callId 过滤；不因为一条坏行拒绝整份历史。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from '../paths'
import type { PermissionMode } from '../../shared/approval'
import type { McpAppViewAuditEntry, McpAppViewAuditPhase } from '../../shared/mcp-app-view'

export const MCP_APP_AUDIT_DIRNAME = 'mcp-app'
export const MCP_APP_AUDIT_SUBDIR = 'audit'
/** 单份会话审计文件上限；超过即轮转，保证有界。 */
export const MCP_APP_AUDIT_MAX_FILE_BYTES = 512 * 1024
/** 单次读取返回的条数上限。 */
export const MCP_APP_AUDIT_MAX_ENTRIES = 2000
/** 摘要文本长度上限；超长截断（摘要由宿主生成，不来自 App 原文）。 */
const SUMMARY_MAX = 400
const REASON_MAX = 300

export interface McpAppViewAuditInput {
  callId: string
  toolName: string
  phase: McpAppViewAuditPhase
  permissionMode: PermissionMode
  summary: string
  serverId?: string
  instanceId?: string
  argsHash?: string
  reason?: string
}

export interface McpAppViewAuditStoreOptions {
  /** 覆盖审计目录（测试用隔离目录）；缺省 `<YAN_DIR>/mcp-app/audit`。 */
  dir?: string
  now?: () => number
  newId?: () => string
  maxFileBytes?: number
  maxEntries?: number
}

function isPhase(value: unknown): value is McpAppViewAuditPhase {
  return (
    value === 'requested' ||
    value === 'denied' ||
    value === 'approved' ||
    value === 'completed' ||
    value === 'error'
  )
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'all' || value === 'danger'
}

/** 去掉控制字符与换行，并截断；JSONL 一行一条，绝不能因摘要里的换行破坏结构。 */
function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : ''
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
}

function isEntry(value: unknown): value is McpAppViewAuditEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.at === 'number' &&
    typeof entry.callId === 'string' &&
    typeof entry.toolName === 'string' &&
    isPhase(entry.phase) &&
    isPermissionMode(entry.permissionMode) &&
    typeof entry.summary === 'string'
  )
}

export class McpAppViewAuditStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly newId: () => string
  private readonly maxFileBytes: number
  private readonly maxEntries: number

  constructor(options: McpAppViewAuditStoreOptions = {}) {
    this.dir = options.dir ?? join(YAN_DIR, MCP_APP_AUDIT_DIRNAME, MCP_APP_AUDIT_SUBDIR)
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.maxFileBytes = options.maxFileBytes ?? MCP_APP_AUDIT_MAX_FILE_BYTES
    this.maxEntries = options.maxEntries ?? MCP_APP_AUDIT_MAX_ENTRIES
  }

  /** 会话文件 → 审计文件路径；缺失 / 空串直接抛错（fail-closed，不写公共文件）。 */
  sessionPath(sessionFile: string): string {
    const key = typeof sessionFile === 'string' ? sessionFile.trim() : ''
    if (!key) throw new Error('缺少会话文件身份，拒绝写 App 审计')
    return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.jsonl`)
  }

  /**
   * 追加一条审计。**必须真实落盘**：任何 IO 失败都抛出，由调用方停止执行。
   */
  async record(sessionFile: string, input: McpAppViewAuditInput): Promise<McpAppViewAuditEntry> {
    const path = this.sessionPath(sessionFile)
    const entry: McpAppViewAuditEntry = {
      id: this.newId(),
      at: this.now(),
      callId: cleanText(input.callId, 200),
      toolName: cleanText(input.toolName, 200),
      phase: input.phase,
      permissionMode: input.permissionMode,
      summary: cleanText(input.summary, SUMMARY_MAX)
    }
    if (input.serverId) entry.serverId = cleanText(input.serverId, 200)
    if (input.instanceId) entry.instanceId = cleanText(input.instanceId, 200)
    if (input.argsHash) entry.argsHash = cleanText(input.argsHash, 128)
    if (input.reason) entry.reason = cleanText(input.reason, REASON_MAX)

    await mkdir(this.dir, { recursive: true })
    await this.rotateIfNeeded(path)
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    return entry
  }

  /** 读取某会话的审计；给 callId 时只回该次调用。坏行跳过。 */
  async read(sessionFile: string, callId?: string): Promise<McpAppViewAuditEntry[]> {
    let path: string
    try {
      path = this.sessionPath(sessionFile)
    } catch {
      return []
    }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return []
    }
    const wanted = typeof callId === 'string' && callId ? callId : undefined
    const out: McpAppViewAuditEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isEntry(parsed)) continue
      if (wanted && parsed.callId !== wanted) continue
      out.push(parsed)
      if (out.length >= this.maxEntries) break
    }
    return out
  }

  /** 删除某会话的审计（会话被删除时收尾用）。 */
  async clearSession(sessionFile: string): Promise<void> {
    let path: string
    try {
      path = this.sessionPath(sessionFile)
    } catch {
      return
    }
    await rm(path, { force: true }).catch(() => undefined)
    await rm(`${path}.1`, { force: true }).catch(() => undefined)
  }

  private async rotateIfNeeded(path: string): Promise<void> {
    let size = 0
    try {
      size = (await stat(path)).size
    } catch {
      return
    }
    if (size < this.maxFileBytes) return
    const rotated = `${path}.1`
    await rm(rotated, { force: true }).catch(() => undefined)
    /* 轮转失败必须抛出：宁可拒绝执行，也不能让审计无界增长。 */
    await rename(path, rotated)
  }
}
