import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentPruneResult, AttachmentUsage } from '../shared/ipc'

export function attachmentsUsage(dir: string): AttachmentUsage {
  if (!existsSync(dir)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      bytes += statSync(join(dir, entry.name)).size
      files += 1
    } catch {
    }
  }
  return { files, bytes }
}

export function attachmentStem(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '')
}

export function listSessionFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 64) throw new Error('会话目录层级过深，已停止附件清理')
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.isSymbolicLink()) throw new Error('会话目录包含符号链接，已停止附件清理')
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(dir, 0)
  return out
}

const IMAGE_HINT = /image|attachments|"data"|base64|[A-Za-z0-9+/]{256,}/i

export function corruptLineMayHoldImage(line: string): boolean {
  return IMAGE_HINT.test(line)
}

export async function referencedAttachmentNames(sessionFiles: string[], options: { skipHarmlessCorruptLines?: boolean } = {}): Promise<Set<string>> {
  const out = new Set<string>()
  for (const file of sessionFiles) {
    const handle = await open(file, 'r')
    try {
      for await (const line of handle.readLines({ encoding: 'utf8' })) {
        if (!line.trim()) continue
        let row: unknown
        try {
          row = JSON.parse(line)
        } catch {
          if (options.skipHarmlessCorruptLines && !corruptLineMayHoldImage(line)) continue
          throw new Error('会话历史不完整，已停止附件清理，请稍后重试')
        }
        collectImageHashes(row, out)
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return out
}

export async function referencedQueueImages(dir: string): Promise<Set<string>> {
  const out = new Set<string>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return out
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.json.reclaimed')) continue
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('A queued message record could not be parsed; attachment cleanup stopped')
    }
    collectQueueImages(parsed, out)
  }
  return out
}

function collectQueueImages(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectQueueImages(item, out)
    return
  }
  const record = value as { data?: unknown; mimeType?: unknown }
  if (typeof record.data === 'string' && record.data && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
    out.add(createHash('sha1').update(record.data).digest('hex'))
  }
  for (const item of Object.values(value)) collectQueueImages(item, out)
}

export async function sessionFilesFingerprint(files: string[], batch = 32): Promise<string> {
  const rows: Array<[string, number, number, number]> = []
  const sorted = [...files].sort()
  for (let start = 0; start < sorted.length; start += batch) {
    const slice = sorted.slice(start, start + batch)
    const stats = await Promise.all(slice.map((file) => stat(file).then((st) => st, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })))
    stats.forEach((st, index) => {
      if (st) rows.push([slice[index], st.size, st.mtimeMs, st.ctimeMs])
    })
  }
  return JSON.stringify(rows)
}

function collectImageHashes(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectImageHashes(item, out)
    return
  }
  const record = value as { type?: unknown; data?: unknown }
  if (record.type === 'image' && typeof record.data === 'string' && record.data) {
    out.add(createHash('sha1').update(record.data).digest('hex'))
  }
  for (const item of Object.values(value)) collectImageHashes(item, out)
}

function staleAttachments(dir: string, referenced: Set<string>, before?: number): { stale: Array<{ file: string; size: number }>; kept: number } {
  const stale: Array<{ file: string; size: number }> = []
  let kept = 0
  if (!existsSync(dir)) return { stale, kept }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (referenced.has(attachmentStem(entry.name))) {
      kept += 1
      continue
    }
    const file = join(dir, entry.name)
    try {
      const st = statSync(file)
      if (before !== undefined && Math.max(st.mtimeMs, st.ctimeMs) >= before) { kept += 1; continue }
      stale.push({ file, size: st.size })
    } catch {
    }
  }
  return { stale, kept }
}

export interface AttachmentTrashOptions {
  before: number
  trash: (file: string) => Promise<void>
  stillIdle?: () => boolean
  log?: (line: string) => void
}

export async function trashStaleAttachments(dir: string, referenced: Set<string>, opts: AttachmentTrashOptions): Promise<AttachmentPruneResult & { failed: number; stopped: boolean }> {
  const { stale, kept } = staleAttachments(dir, referenced, opts.before)
  let removed = 0
  let bytes = 0
  let failed = 0
  let stopped = false
  for (const item of stale) {
    if (opts.stillIdle && !opts.stillIdle()) {
      stopped = true
      break
    }
    try {
      const st = statSync(item.file)
      if (Math.max(st.mtimeMs, st.ctimeMs) >= opts.before) continue
    } catch {
      continue
    }
    try {
      await opts.trash(item.file)
      removed += 1
      bytes += item.size
    } catch (error) {
      failed += 1
      opts.log?.(`[attachments] moving to the Recycle Bin failed, skipped ${item.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { removed, bytes, kept, failed, stopped }
}

export function pruneAttachments(
  dir: string,
  referenced: Set<string>,
  opts?: { dryRun?: boolean; before?: number }
): AttachmentPruneResult {
  if (!existsSync(dir)) return { removed: 0, bytes: 0, kept: 0 }
  let removed = 0
  let bytes = 0
  let kept = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (referenced.has(attachmentStem(entry.name))) {
      kept += 1
      continue
    }
    const file = join(dir, entry.name)
    let size = 0
    try {
      const st = statSync(file)
      if (opts?.before !== undefined && Math.max(st.mtimeMs, st.ctimeMs) >= opts.before) { kept += 1; continue }
      size = st.size
    } catch {
      continue
    }
    if (!opts?.dryRun) {
      try {
        unlinkSync(file)
      } catch {
        continue
      }
    }
    removed += 1
    bytes += size
  }
  return { removed, bytes, kept }
}
