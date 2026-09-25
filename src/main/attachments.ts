/**
 * 图片附件目录的占用统计与手动清理。
 *
 * 背景（用户 2026-09-25）：贴进对话的图与工具截图会落到
 * `~/.pi/agent/yan/attachments/<sha1>.<ext>`。落盘解决了「重启后看不到图」，
 * 但这个目录只会涨。
 *
 * 为什么**不做自动清理**：查了本机的 Codex / opencode / Cline，三家都不做 ——
 * Codex 的用户图干脆丢给系统 Temp 去清，持久目录（generated_images）只增不减。
 * 按时间删（TTL）会删掉用户还没翻到的旧图，而这点空间不值得冒误删的风险。
 * 所以这里只提供「可见 + 手动清」：算出占用，并删掉**没有任何会话引用**的那些。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentPruneResult, AttachmentUsage } from '../shared/ipc'

/** 附件目录当前占用。目录不存在就是 0，不创建。 */
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
      /* 读不到就跳过：清理功能不该因为一个坏文件整体失败 */
    }
  }
  return { files, bytes }
}

/** 文件名去掉后缀 = 内容 sha1（见 image-store.ts 的命名规则） */
export function attachmentStem(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '')
}

/**
 * 会话目录下的所有 `.jsonl`。
 *
 * 不复用 `sessions.ts` 的 `listSessions()`：那个会解析每个会话的标题，而且
 * 只取最近 N 条 —— 清理必须看到**全部**会话，否则会删掉只被旧会话引用的附件。
 * 这里只收集路径，不读内容。
 */
export function listSessionFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(dir, 0)
  return out
}

/**
 * 扫会话文件，收集仍被引用的附件名（内容 sha1）。
 *
 * 会话 JSONL 里存的是图片的 base64 —— 那是 pi 的记录格式，改不了；而附件
 * 文件名恰好是同一段 base64 的 sha1，所以扫一遍会话就知道哪些附件还挂在
 * 某条历史消息上。只有含 `"type":"image"` 的行才解析，其余整行跳过。
 *
 * 用异步读（而不是 readFileSync）：用户有几百 MB 会话，同步读会把主进程
 * 卡住几秒 —— 那是整个 UI 一起冻。
 */
export async function referencedAttachmentNames(sessionFiles: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const file of sessionFiles) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"image"')) continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
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

/**
 * 删掉没有被任何会话引用的附件。
 *
 * `dryRun` 只统计不落删，设置页可以先用它给用户看「会清掉多少」。
 * 判断只认内容 sha1：**不按时间删**，所以翻旧会话永远不会遇到空图。
 */
export function pruneAttachments(
  dir: string,
  referenced: Set<string>,
  opts?: { dryRun?: boolean }
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
      size = statSync(file).size
    } catch {
      /* 大小拿不到也要删：这个文件已经没人用了 */
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
