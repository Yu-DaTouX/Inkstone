import { pick } from '../../shared/ui-lang'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
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
        buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count) throw new Error(pick('zip 中央目录损坏或跨卷', 'Corrupt zip central directory or multi-volume zip'))
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error(pick('zip 中央目录损坏', 'Corrupt zip central directory'))
      const method = buf.readUInt16LE(offset + 10)
      const compressedSize = buf.readUInt32LE(offset + 20)
      const size = buf.readUInt32LE(offset + 24)
      const nameLength = buf.readUInt16LE(offset + 28)
      const extraLength = buf.readUInt16LE(offset + 30)
      const commentLength = buf.readUInt16LE(offset + 32)
      const localOffset = buf.readUInt32LE(offset + 42)
      if (offset + 46 + nameLength + extraLength + commentLength > eocd ||
          (buf.readUInt16LE(offset + 8) & 1) || size === 0xffffffff || compressedSize === 0xffffffff) {
        throw new Error(pick('zip 条目损坏或使用不支持的加密 / zip64', 'Corrupt zip entry, or unsupported encryption / zip64'))
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
    throw new Error(pick('不是 zip 文件（找不到结束目录）', 'Not a zip file (end directory not found)'))
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
    if (entry.size > this.maxEntryBytes) throw new Error(pick(`zip 条目过大：${name}`, `Zip entry too large: ${name}`))
    const at = entry.localOffset
    if (at + 30 > this.buf.length || this.buf.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error(pick(`zip 条目头损坏：${name}`, `Corrupt zip entry header: ${name}`))
    const start = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28)
    if (start + entry.compressedSize > this.directoryStart || this.buf.readUInt16LE(at + 8) !== entry.method) throw new Error(pick(`zip 条目数据不完整：${name}`, `Incomplete zip entry data: ${name}`))
    if (!this.charged.has(name) && this.expandedBytes + entry.size > this.maxTotalBytes) {
      throw new Error(pick('zip 解压总量超过预览上限，请用系统程序打开', 'Unzipped size exceeds the preview limit. Open it with a system app'))
    }
    const data = this.buf.subarray(start, start + entry.compressedSize)
    if (entry.method === 0 && (data.length > this.maxEntryBytes || data.length !== entry.size)) {
      throw new Error(pick(`zip 条目大小不符：${name}`, `Zip entry size mismatch: ${name}`))
    }
    let result: Buffer
    if (entry.method === 0) result = Buffer.from(data)
    else if (entry.method === 8) result = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(entry.size, this.maxEntryBytes)) })
    else throw new Error(pick(`不支持的 zip 压缩方式 ${entry.method}：${name}`, `Unsupported zip compression method ${entry.method}: ${name}`))
    if (result.length !== entry.size) throw new Error(pick(`zip 条目大小不符：${name}`, `Zip entry size mismatch: ${name}`))
    if (!this.charged.has(name)) { this.charged.add(name); this.expandedBytes += result.length }
    return result
  }

  text(name: string): string | null {
    return this.read(name)?.toString('utf8') ?? null
  }
}
