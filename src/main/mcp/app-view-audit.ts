import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from '../paths'
import type { PermissionMode } from '../../shared/approval'
import type { McpAppViewAuditEntry, McpAppViewAuditPhase } from '../../shared/mcp-app-view'

export const MCP_APP_AUDIT_DIRNAME = 'mcp-app'
export const MCP_APP_AUDIT_SUBDIR = 'audit'
export const MCP_APP_AUDIT_MAX_FILE_BYTES = 512 * 1024
export const MCP_APP_AUDIT_MAX_ENTRIES = 2000
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

  sessionPath(sessionFile: string): string {
    const key = typeof sessionFile === 'string' ? sessionFile.trim() : ''
    if (!key) throw new Error('缺少会话文件身份，拒绝写 App 审计')
    return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.jsonl`)
  }

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
    await rename(path, rotated)
  }
}
