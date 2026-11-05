import { inflateRawSync } from 'node:zlib'
const EOCD_SIGNATURE = 101010256
const CENTRAL_SIGNATURE = 33639248
const LOCAL_SIGNATURE = 67324752
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
class ZipReader {
  constructor(buf, maxEntryBytes = MAX_ENTRY_BYTES, maxTotalBytes = maxEntryBytes * 4) {
    this.buf = buf
    this.maxEntryBytes = maxEntryBytes
    this.maxTotalBytes = maxTotalBytes
    const eocd = this.findEocd()
    const count = buf.readUInt16LE(eocd + 10)
    let offset = buf.readUInt32LE(eocd + 16)
    this.directoryStart = offset
    if (offset + buf.readUInt32LE(eocd + 12) > eocd || buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count) throw new Error('zip 中央目录损坏或跨卷')
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('zip 中央目录损坏')
      const method = buf.readUInt16LE(offset + 10)
      const compressedSize = buf.readUInt32LE(offset + 20)
      const size = buf.readUInt32LE(offset + 24)
      const nameLength = buf.readUInt16LE(offset + 28)
      const extraLength = buf.readUInt16LE(offset + 30)
      const commentLength = buf.readUInt16LE(offset + 32)
      const localOffset = buf.readUInt32LE(offset + 42)
      if (offset + 46 + nameLength + extraLength + commentLength > eocd || buf.readUInt16LE(offset + 8) & 1 || size === 4294967295 || compressedSize === 4294967295) {
        throw new Error('zip 条目损坏或使用不支持的加密 / zip64')
      }
      const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
      this.entries.set(name, { name, method, compressedSize, size, localOffset })
      offset += 46 + nameLength + extraLength + commentLength
    }
  }
  buf
  maxEntryBytes
  maxTotalBytes
  entries = new Map()
  expandedBytes = 0
  charged = new Set()
  directoryStart
  findEocd() {
    const min = Math.max(0, this.buf.length - 65557)
    for (let i = this.buf.length - 22; i >= min; i--) {
      if (this.buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
    }
    throw new Error('不是 zip 文件（找不到结束目录）')
  }
  has(name) {
    return this.entries.has(name)
  }
  names() {
    return [...this.entries.keys()]
  }
  read(name) {
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
    let result
    if (entry.method === 0) result = Buffer.from(data)
    else if (entry.method === 8) result = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(entry.size, this.maxEntryBytes)) })
    else throw new Error(`不支持的 zip 压缩方式 ${entry.method}：${name}`)
    if (result.length !== entry.size) throw new Error(`zip 条目大小不符：${name}`)
    if (!this.charged.has(name)) {
      this.charged.add(name)
      this.expandedBytes += result.length
    }
    return result
  }
  text(name) {
    return this.read(name)?.toString('utf8') ?? null
  }
}
export {
  ZipReader
}
