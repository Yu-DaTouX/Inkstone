import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileUrl } from '../shared/file-url'

/** mimeType → 文件后缀（认不出就不给有意义的后缀，文件本身仍能按内容打开） */
function extOf(mimeType: string): string {
  const m = mimeType.toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  return 'bin'
}

/** 图片在受控目录里的一份实体文件（内容 sha1 命名） */
export function imageFile(dir: string, mimeType: string, data: string): string {
  return join(dir, `${createHash('sha1').update(data).digest('hex')}.${extOf(mimeType)}`)
}

/**
 * 用户贴进对话的图片：**落盘一份，消息里只留文件地址**。
 *
 * 为什么（用户 2026-09-25：「图片在重启后仍然看不到」）：
 *   图片以 base64 存在会话文件里（实测用户 128 张，最大单张 3.4MB）。
 *   历史重读时不可能把这些 base64 塞进内存与 IPC，所以之前一律丢弃 ——
 *   结果是重启、切会话、压缩之后，用户贴过的图只剩一个「图片未载入」占位。
 *   落盘之后地址是稳定的：不依赖本次运行期内存里的那份 base64。
 *
 * 文件名用**内容 sha1**：同一张图重复贴、跨会话贴只存一份，重复打开会话
 * 也只 stat 一次（已存在就直接返回地址）。
 *
 * 同步写是有意的：它发生在打开会话时，20MB 图片顺序写约 100-200ms，
 * 换来的是渲染端不需要一整套异步加载 + 失败重试 + 缓存失效逻辑。
 */
export function localizeImage(dir: string, mimeType: string, data: string): string {
  const file = imageFile(dir, mimeType, data)
  const expected = Buffer.from(data, 'base64')
  try {
    const existing = readFileSync(file)
    if (existing.length === expected.length && createHash('sha1').update(existing).digest('hex') === createHash('sha1').update(expected).digest('hex')) return fileUrl(file)
  } catch { /* 缺失或损坏的缓存要重建 */ }
  mkdirSync(dir, { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, expected, { flag: 'wx' })
    try { renameSync(temp, file) }
    catch (error) {
      // 目标缓存可能是损坏文件；Windows 不允许 rename 覆盖，先移除无效目标再安装临时文件。
      try { unlinkSync(file) } catch { /* 目标可能已被并发清理 */ }
      renameSync(temp, file)
    }
  } finally {
    try { unlinkSync(temp) } catch { /* rename 后临时文件已不存在 */ }
  }
  return fileUrl(file)
}
