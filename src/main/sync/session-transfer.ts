/**
 * 会话导出 / 导入：纯函数，不碰同步目录、不依赖 Electron。
 *
 * 会话本体**不同步**（体积大、含本机 cwd 与运行历史）；用户要跨设备搬一条会话时，
 * 用「导出到指定路径 / 从指定路径导入」两个显式动作。
 *
 * 打包格式是一个 JSON：`{ v, kind:"inkstone-session", exportedAt, fileName, content }`，
 * content 为原会话 JSONL 原文。导入时生成新会话 id（改写文件头 `type:"session"` 的 id），
 * 目标文件名已存在时不覆盖，换一个新 id 再写。
 */
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
  /*
   * 生成新 id 并改写文件头；目标文件名冲突时换一个 id 重试，绝不覆盖同名会话。
   * 会话文件名与 id 都是随机 uuid，正常情况下一次就成。
   */
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

/** 从会话 JSONL 文件头里读原会话 id；读不到返回 undefined。 */
export function readSessionId(content: string): string | undefined {
  for (const line of content.split('\n')) {
    if (!line.includes('"type":"session"')) continue
    try {
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown }
      if (parsed?.type === 'session' && typeof parsed.id === 'string' && parsed.id) return parsed.id
    } catch {
      /* 坏行跳过，继续找下一行。 */
    }
  }
  return undefined
}

/** 把文件头 `type:"session"` 那条的 id 换成 newId，其余行原样保留。 */
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
      /* 继续找。 */
    }
  }
  return content
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
