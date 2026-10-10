/**
 * 最小 zip 读取器：只为 docx / xlsx / pptx 取出内部的 XML。
 *
 * Office Open XML 就是 zip 包；这里只实现「读中央目录 → 按名取条目 → stored / deflate 解压」，
 * 不写 zip、不支持加密与 zip64（Office 文件远到不了 4GB）。为此引一个依赖不值得。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** 单个条目解压后的上限：防止「zip 炸弹」把内存撑爆 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>()
  private expandedBytes = 0
  private readonly charged = new Set<string>()
  private readonly directoryStart: number

  constructor(private readonly buf: Buffer, private readonly maxEntryBytes = MAX_ENTRY_BYTES,
    private readonly maxTotalBytes = maxEntryBytes * 4) {
    const eocd = this.findEocd()
    const count = buf.readUInt16LE(eocd + 10)
    let offset = buf.readUInt32LE(eocd + 16)
    this.directoryStart = offset
    if (offset + buf.readUInt32LE(eocd + 12) > eocd || buf.readUInt16LE(eocd + 4) !== 0 ||
        buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count) throw new Error('zip 中央目录损坏或跨卷')
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('zip 中央目录损坏')
      const method = buf.readUInt16LE(offset + 10)
      const compressedSize = buf.readUInt32LE(offset + 20)
      const size = buf.readUInt32LE(offset + 24)
      const nameLength = buf.readUInt16LE(offset + 28)
      const extraLength = buf.readUInt16LE(offset + 30)
      const commentLength = buf.readUInt16LE(offset + 32)
      const localOffset = buf.readUInt32LE(offset + 42)
      if (offset + 46 + nameLength + extraLength + commentLength > eocd ||
          (buf.readUInt16LE(offset + 8) & 1) || size === 0xffffffff || compressedSize === 0xffffffff) {
        throw new Error('zip 条目损坏或使用不支持的加密 / zip64')
      }
      const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
      this.entries.set(name, { name, method, compressedSize, size, localOffset })
      offset += 46 + nameLength + extraLength + commentLength
    }
  }

  private findEocd(): number {
    const min = Math.max(0, this.buf.length - 65_557)
    for (let i = this.buf.length - 22; i >= min; i--) {
      if (this.buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
    }
    throw new Error('不是 zip 文件（找不到结束目录）')
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  read(name: string): Buffer | null {
    const entry = this.entries.get(name)
    if (!entry) return null
    if (entry.size > this.maxEntryBytes) throw new Error(`zip 条目过大：${name}`)
    const at = entry.localOffset
    if (at + 30 > this.buf.length || this.buf.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error(`zip 条目头损坏：${name}`)
    const start = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28)
    if (start + entry.compressedSize > this.directoryStart || this.buf.readUInt16LE(at + 8) !== entry.method) throw new Error(`zip 条目数据不完整：${name}`)
    if (!this.charged.has(name) && this.expandedBytes + entry.size > this.maxTotalBytes) {
      throw new Error('zip 解压总量超过预览上限，请用系统程序打开')
    }
    const data = this.buf.subarray(start, start + entry.compressedSize)
    if (entry.method === 0 && (data.length > this.maxEntryBytes || data.length !== entry.size)) {
      throw new Error(`zip 条目大小不符：${name}`)
    }
    let result: Buffer
    if (entry.method === 0) result = Buffer.from(data)
    else if (entry.method === 8) result = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(entry.size, this.maxEntryBytes)) })
    else throw new Error(`不支持的 zip 压缩方式 ${entry.method}：${name}`)
    if (result.length !== entry.size) throw new Error(`zip 条目大小不符：${name}`)
    if (!this.charged.has(name)) { this.charged.add(name); this.expandedBytes += result.length }
    return result
  }

  text(name: string): string | null {
    return this.read(name)?.toString('utf8') ?? null
  }
}
