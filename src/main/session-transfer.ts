import { pick } from '../shared/ui-lang'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './atomic-write'

export const SESSION_BUNDLE_KIND = 'inkstone-session'
export const SESSION_BUNDLE_VERSION = 1
export const SESSION_TRANSFER_MAX_BYTES = 64 * 1024 * 1024

export interface SessionBundle {
  v: 1
  kind: typeof SESSION_BUNDLE_KIND
  exportedAt: number
  fileName: string
  sourceSessionId?: string
  content: string
}

export interface SessionTransferOptions {
  now?: () => number
  newId?: () => string
}

export type ExportSessionResult =
  | { ok: true; path: string; bytes: number; sourceSessionId?: string }
  | { ok: false; error: string }

export type ImportSessionResult =
  | { ok: true; path: string; sessionId: string; renamedFrom?: string }
  | { ok: false; error: string }

export async function exportSession(
  sessionFilePath: string,
  targetPath: string,
  options: SessionTransferOptions = {}
): Promise<ExportSessionResult> {
  if (!sessionFilePath || !existsSync(sessionFilePath)) return { ok: false, error: pick(`会话文件不存在：${sessionFilePath}`, `Session file not found: ${sessionFilePath}`) }
  if (!targetPath) return { ok: false, error: pick('缺少导出目标路径', 'Missing export target path') }
  let content: string
  try {
    content = await readFile(sessionFilePath, 'utf8')
  } catch (error) {
    return { ok: false, error: pick(`读取会话失败：${describe(error)}`, `Failed to read session: ${describe(error)}`) }
  }
  if (Buffer.byteLength(content, 'utf8') > SESSION_TRANSFER_MAX_BYTES) {
    return { ok: false, error: pick('会话过大，超过单次导出上限 64MB', 'Session is too large; exceeds the 64MB export limit') }
  }
  const sourceSessionId = readSessionId(content)
  const bundle: SessionBundle = {
    v: SESSION_BUNDLE_VERSION,
    kind: SESSION_BUNDLE_KIND,
    exportedAt: (options.now ?? Date.now)(),
    fileName: basename(sessionFilePath),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    content
  }
  const file = targetPath.toLowerCase().endsWith('.json') ? targetPath : `${targetPath}.inkstone-session.json`
  try {
    await atomicWriteFile(file, JSON.stringify(bundle, null, 2))
  } catch (error) {
    return { ok: false, error: pick(`写出会话包失败：${describe(error)}`, `Failed to write session bundle: ${describe(error)}`) }
  }
  return { ok: true, path: file, bytes: Buffer.byteLength(content, 'utf8'), ...(sourceSessionId ? { sourceSessionId } : {}) }
}

export async function importSession(
  bundlePath: string,
  sessionsDir: string,
  options: SessionTransferOptions = {}
): Promise<ImportSessionResult> {
  if (!bundlePath || !existsSync(bundlePath)) return { ok: false, error: pick(`会话包不存在：${bundlePath}`, `Session bundle not found: ${bundlePath}`) }
  if (!sessionsDir) return { ok: false, error: pick('缺少会话目录', 'Missing sessions folder') }
  const size = await stat(bundlePath).then(
    (info) => info.size,
    () => 0
  )
  if (size > SESSION_TRANSFER_MAX_BYTES) return { ok: false, error: pick('会话包过大，超过导入上限 64MB', 'Session bundle is too large; exceeds the 64MB import limit') }
  let bundle: SessionBundle
  try {
    bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as SessionBundle
  } catch (error) {
    return { ok: false, error: pick(`会话包解析失败：${describe(error)}`, `Failed to parse session bundle: ${describe(error)}`) }
  }
  if (
    !bundle ||
    bundle.v !== SESSION_BUNDLE_VERSION ||
    bundle.kind !== SESSION_BUNDLE_KIND ||
    typeof bundle.content !== 'string' ||
    !bundle.content
  ) {
    return { ok: false, error: pick('不是有效的砚会话包', 'Not a valid Inkstone session bundle') }
  }
  const nextId = options.newId ?? (() => randomUUID())
  const originalId = readSessionId(bundle.content)
  if (!originalId) return { ok: false, error: pick('会话包缺少唯一有效的 session 头', 'Session bundle lacks exactly one valid session header') }
  let sessionId = ''
  let file = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    sessionId = nextId()
    if (sessionId === originalId) continue
    file = join(sessionsDir, `${sessionId}.jsonl`)
    if (!existsSync(file)) break
    file = ''
  }
  if (!file) return { ok: false, error: pick('生成新会话名失败（目标目录已有同名文件）', 'Failed to create a new session name (file already exists)') }
  const content = rewriteSessionId(bundle.content, sessionId)
  if (readSessionId(content) !== sessionId) return { ok: false, error: pick('改写会话 session 头失败', 'Failed to rewrite the session header') }
  try {
    await mkdir(sessionsDir, { recursive: true })
    await atomicWriteFile(file, content)
  } catch (error) {
    return { ok: false, error: pick(`写出会话失败：${describe(error)}`, `Failed to write session: ${describe(error)}`) }
  }
  return { ok: true, path: file, sessionId, ...(originalId ? { renamedFrom: originalId } : {}) }
}

export function readSessionId(content: string): string | undefined {
  let id: string | undefined
  for (const line of content.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown }
      if (parsed?.type !== 'session') continue
      if (id !== undefined || typeof parsed.id !== 'string' || !parsed.id.trim()) return undefined
      id = parsed.id
    } catch {
    }
  }
  return id
}

export function rewriteSessionId(content: string, newId: string): string {
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed?.type === 'session' && typeof parsed.id === 'string' && parsed.id) {
        parsed.id = newId
        lines[index] = JSON.stringify(parsed)
        return lines.join('\n')
      }
    } catch {
    }
  }
  return content
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
