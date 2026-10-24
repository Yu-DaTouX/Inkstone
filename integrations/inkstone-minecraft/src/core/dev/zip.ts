import { open } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
}

export class ZipReader {
  readonly file: string
  readonly entries: Map<string, ZipEntry>

  private constructor(file: string, entries: Map<string, ZipEntry>) {
    this.file = file
    this.entries = entries
  }

  static async open(file: string): Promise<ZipReader> {
    const handle = await open(file, 'r')
    try {
      const size = (await handle.stat()).size
      const tailSize = Math.min(size, 65_557)
      const tail = Buffer.alloc(tailSize)
      await handle.read(tail, 0, tailSize, size - tailSize)
      let eocd = -1
      for (let index = tailSize - 22; index >= 0; index--) {
        if (tail.readUInt32LE(index) === 0x06054b50) {
          eocd = index
          break
        }
      }
      if (eocd < 0) throw new Error(`${file} 不是 zip/jar 文件`)
      const count = tail.readUInt16LE(eocd + 10)
      const dirSize = tail.readUInt32LE(eocd + 12)
      const dirOffset = tail.readUInt32LE(eocd + 16)
      const dir = Buffer.alloc(dirSize)
      await handle.read(dir, 0, dirSize, dirOffset)
      const entries = new Map<string, ZipEntry>()
      let cursor = 0
      for (let index = 0; index < count && cursor + 46 <= dir.length; index++) {
        if (dir.readUInt32LE(cursor) !== 0x02014b50) break
        const method = dir.readUInt16LE(cursor + 10)
        const compressedSize = dir.readUInt32LE(cursor + 20)
        const uncompressed = dir.readUInt32LE(cursor + 24)
        const nameLength = dir.readUInt16LE(cursor + 28)
        const extraLength = dir.readUInt16LE(cursor + 30)
        const commentLength = dir.readUInt16LE(cursor + 32)
        const offset = dir.readUInt32LE(cursor + 42)
        const name = dir.toString('utf8', cursor + 46, cursor + 46 + nameLength)
        entries.set(name, { name, method, compressedSize, size: uncompressed, offset })
        cursor += 46 + nameLength + extraLength + commentLength
      }
      return new ZipReader(file, entries)
    } finally {
      await handle.close()
    }
  }

  async read(name: string): Promise<Buffer | null> {
    const entry = this.entries.get(name)
    if (!entry) return null
    const handle = await open(this.file, 'r')
    try {
      const header = Buffer.alloc(30)
      await handle.read(header, 0, 30, entry.offset)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name} 的本地文件头损坏`)
      const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      const data = Buffer.alloc(entry.compressedSize)
      await handle.read(data, 0, entry.compressedSize, start)
      if (entry.method === 0) return data
      if (entry.method === 8) return inflateRawSync(data)
      throw new Error(`${name} 使用了不支持的压缩方式 ${entry.method}`)
    } finally {
      await handle.close()
    }
  }

  async readAll(filter: (name: string) => boolean, visit: (name: string, data: Buffer) => Promise<void> | void): Promise<number> {
    const handle = await open(this.file, 'r')
    let visited = 0
    try {
      for (const entry of this.entries.values()) {
        if (entry.name.endsWith('/') || !filter(entry.name)) continue
        const header = Buffer.alloc(30)
        await handle.read(header, 0, 30, entry.offset)
        const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
        const data = Buffer.alloc(entry.compressedSize)
        await handle.read(data, 0, entry.compressedSize, start)
        await visit(entry.name, entry.method === 8 ? inflateRawSync(data) : data)
        visited += 1
      }
    } finally {
      await handle.close()
    }
    return visited
  }
}
