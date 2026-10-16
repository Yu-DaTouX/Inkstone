import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

export async function referencedAttachmentNames(sessionFiles: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const file of sessionFiles) {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        throw new Error('会话历史不完整，已停止附件清理，请稍后重试')
      }
      collectImageHashes(row, out)
    }
  }
  return out
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
