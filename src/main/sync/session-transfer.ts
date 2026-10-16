import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './atomic'

export const SESSION_BUNDLE_KIND = 'inkstone-session'
export const SESSION_BUNDLE_VERSION = 1

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
  if (!sessionFilePath || !existsSync(sessionFilePath)) return { ok: false, error: `会话文件不存在：${sessionFilePath}` }
  if (!targetPath) return { ok: false, error: '缺少导出目标路径' }
  let content: string
  try {
    content = await readFile(sessionFilePath, 'utf8')
  } catch (error) {
    return { ok: false, error: `读取会话失败：${describe(error)}` }
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
    return { ok: false, error: `写出会话包失败：${describe(error)}` }
  }
  return { ok: true, path: file, bytes: Buffer.byteLength(content, 'utf8'), ...(sourceSessionId ? { sourceSessionId } : {}) }
}

export async function importSession(
  bundlePath: string,
  sessionsDir: string,
  options: SessionTransferOptions = {}
): Promise<ImportSessionResult> {
  if (!bundlePath || !existsSync(bundlePath)) return { ok: false, error: `会话包不存在：${bundlePath}` }
  if (!sessionsDir) return { ok: false, error: '缺少会话目录' }
  let bundle: SessionBundle
  try {
    bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as SessionBundle
  } catch (error) {
    return { ok: false, error: `会话包解析失败：${describe(error)}` }
  }
  if (
    !bundle ||
    bundle.v !== SESSION_BUNDLE_VERSION ||
    bundle.kind !== SESSION_BUNDLE_KIND ||
    typeof bundle.content !== 'string' ||
    !bundle.content
  ) {
    return { ok: false, error: '不是有效的砚会话包' }
  }
  const nextId = options.newId ?? (() => randomUUID())
  const originalId = readSessionId(bundle.content)
  let sessionId = ''
  let file = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    sessionId = nextId()
    file = join(sessionsDir, `${sessionId}.jsonl`)
    if (!existsSync(file)) break
    file = ''
  }
  if (!file) return { ok: false, error: '生成新会话名失败（目标目录已有同名文件）' }
  const content = rewriteSessionId(bundle.content, sessionId)
  try {
    await mkdir(sessionsDir, { recursive: true })
    await atomicWriteFile(file, content)
  } catch (error) {
    return { ok: false, error: `写出会话失败：${describe(error)}` }
  }
  return { ok: true, path: file, sessionId, ...(originalId ? { renamedFrom: originalId } : {}) }
}

export function readSessionId(content: string): string | undefined {
  for (const line of content.split('\n')) {
    if (!line.includes('"type":"session"')) continue
    try {
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown }
      if (parsed?.type === 'session' && typeof parsed.id === 'string' && parsed.id) return parsed.id
    } catch {
    }
  }
  return undefined
}

export function rewriteSessionId(content: string, newId: string): string {
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.includes('"type":"session"')) continue
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
