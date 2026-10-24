import { gunzipSync, inflateSync } from 'node:zlib'

export type NbtValue = number | string | NbtValue[] | NbtCompound

export interface NbtCompound {
  [key: string]: NbtValue
}

const TAG_END = 0
const TAG_BYTE = 1
const TAG_SHORT = 2
const TAG_INT = 3
const TAG_LONG = 4
const TAG_FLOAT = 5
const TAG_DOUBLE = 6
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10
const TAG_INT_ARRAY = 11
const TAG_LONG_ARRAY = 12

class NbtReader {
  private readonly data: Buffer
  private offset = 0

  constructor(data: Buffer) {
    this.data = data
  }

  private need(count: number): void {
    if (count < 0) throw new Error('NBT 里的长度是负数')
    if (this.offset + count > this.data.length) throw new Error('NBT 数据还没读完就结束了（文件可能被截断）')
  }

  private uint8(): number {
    this.need(1)
    return this.data[this.offset++]
  }

  private int8(): number {
    this.need(1)
    return this.data.readInt8(this.offset++)
  }

  private int16(): number {
    this.need(2)
    const value = this.data.readInt16BE(this.offset)
    this.offset += 2
    return value
  }

  private uint16(): number {
    this.need(2)
    const value = this.data.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  private int32(): number {
    this.need(4)
    const value = this.data.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  private int64(): number {
    this.need(8)
    const value = Number(this.data.readBigInt64BE(this.offset))
    this.offset += 8
    return value
  }

  private float(): number {
    this.need(4)
    const value = this.data.readFloatBE(this.offset)
    this.offset += 4
    return value
  }

  private double(): number {
    this.need(8)
    const value = this.data.readDoubleBE(this.offset)
    this.offset += 8
    return value
  }

  private text(): string {
    const length = this.uint16()
    this.need(length)
    const value = this.data.toString('utf8', this.offset, this.offset + length)
    this.offset += length
    return value
  }

  root(): NbtCompound {
    const type = this.uint8()
    if (type !== TAG_COMPOUND) throw new Error(`NBT 根标签不是 compound（类型 ${type}）`)
    this.text()
    return this.payload(TAG_COMPOUND) as NbtCompound
  }

  private payload(type: number): NbtValue {
    switch (type) {
      case TAG_BYTE:
        return this.int8()
      case TAG_SHORT:
        return this.int16()
      case TAG_INT:
        return this.int32()
      case TAG_LONG:
        return this.int64()
      case TAG_FLOAT:
        return this.float()
      case TAG_DOUBLE:
        return this.double()
      case TAG_BYTE_ARRAY: {
        const length = this.int32()
        this.need(length)
        const values: NbtValue[] = []
        for (let index = 0; index < length; index++) values.push(this.data.readInt8(this.offset + index))
        this.offset += length
        return values
      }
      case TAG_STRING:
        return this.text()
      case TAG_LIST: {
        const itemType = this.uint8()
        const length = this.int32()
        const values: NbtValue[] = []
        for (let index = 0; index < length; index++) values.push(this.payload(itemType))
        return values
      }
      case TAG_COMPOUND: {
        const values: NbtCompound = {}
        for (;;) {
          const tag = this.uint8()
          if (tag === TAG_END) return values
          const name = this.text()
          values[name] = this.payload(tag)
        }
      }
      case TAG_INT_ARRAY: {
        const length = this.int32()
        this.need(length * 4)
        const values: NbtValue[] = []
        for (let index = 0; index < length; index++) values.push(this.data.readInt32BE(this.offset + index * 4))
        this.offset += length * 4
        return values
      }
      case TAG_LONG_ARRAY: {
        const length = this.int32()
        this.need(length * 8)
        const values: NbtValue[] = []
        for (let index = 0; index < length; index++) values.push(Number(this.data.readBigInt64BE(this.offset + index * 8)))
        this.offset += length * 8
        return values
      }
      default:
        throw new Error(`未知的 NBT 标签类型 ${type}`)
    }
  }
}

export function decompressNbt(bytes: Buffer): Buffer {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes)
  if (bytes.length >= 2 && bytes[0] === 0x78) {
    try {
      return inflateSync(bytes)
    } catch {
      return bytes
    }
  }
  return bytes
}

export function readNbt(bytes: Buffer): NbtCompound {
  return new NbtReader(decompressNbt(bytes)).root()
}
