import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function varint(buf, pos) {
  let result = 0
  let shift = 0
  for (;;) {
    const byte = buf[pos++]
    result += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return [result, pos]
    shift += 7
  }
}

export function snappyDecompress(input) {
  let [length, pos] = varint(input, 0)
  const out = Buffer.alloc(length)
  let o = 0
  while (pos < input.length) {
    const tag = input[pos++]
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >> 2
      if (len >= 60) {
        const bytes = len - 59
        len = input.readUIntLE(pos, bytes)
        pos += bytes
      }
      len += 1
      input.copy(out, o, pos, pos + len)
      pos += len
      o += len
      continue
    }
    let len
    let offset
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4
      offset = ((tag >> 5) << 8) | input[pos++]
    } else if (kind === 2) {
      len = (tag >> 2) + 1
      offset = input.readUInt16LE(pos)
      pos += 2
    } else {
      len = (tag >> 2) + 1
      offset = input.readUInt32LE(pos)
      pos += 4
    }
    if (!offset || offset > o) throw new Error('snappy: 偏移越界')
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset]
  }
  if (o !== length) throw new Error('snappy: 长度不符')
  return out
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size)
  const type = file[offset + size]
  if (type === 0) return raw
  if (type === 1) return snappyDecompress(raw)
  throw new Error(`未知块压缩类型 ${type}`)
}

function blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4)
  const end = block.length - 4 - restarts * 4
  const entries = []
  let pos = 0
  let last = Buffer.alloc(0)
  while (pos < end) {
    let shared
    let unshared
    let valueLen
    ;[shared, pos] = varint(block, pos)
    ;[unshared, pos] = varint(block, pos)
    ;[valueLen, pos] = varint(block, pos)
    const key = Buffer.concat([last.subarray(0, shared), block.subarray(pos, pos + unshared)])
    pos += unshared
    entries.push([key, block.subarray(pos, pos + valueLen)])
    pos += valueLen
    last = key
  }
  return entries
}

function readTable(buf, sink) {
  const footer = buf.subarray(buf.length - 48)
  let pos = 0
  ;[, pos] = varint(footer, pos)
  ;[, pos] = varint(footer, pos)
  let indexOffset
  let indexSize
  ;[indexOffset, pos] = varint(footer, pos)
  ;[indexSize, pos] = varint(footer, pos)
  for (const [, handle] of blockEntries(readBlock(buf, indexOffset, indexSize))) {
    const [offset, p] = varint(handle, 0)
    const [size] = varint(handle, p)
    for (const [internal, value] of blockEntries(readBlock(buf, offset, size))) {
      if (internal.length < 8) continue
      const tail = internal.readBigUInt64LE(internal.length - 8)
      sink(internal.subarray(0, internal.length - 8), Number(tail >> 8n), Number(tail & 0xffn), value)
    }
  }
}

function readLog(buf, sink) {
  const BLOCK = 32768
  const records = []
  let pending = []
  let pos = 0
  while (pos + 7 <= buf.length) {
    const left = BLOCK - (pos % BLOCK)
    if (left < 7) { pos += left; continue }
    const length = buf.readUInt16LE(pos + 4)
    const type = buf[pos + 6]
    if (type === 0 && length === 0) { pos += left; continue }
    const data = buf.subarray(pos + 7, pos + 7 + length)
    pos += 7 + length
    if (type === 1) records.push(data)
    else if (type === 2) pending = [data]
    else if (type === 3) pending.push(data)
    else if (type === 4) { pending.push(data); records.push(Buffer.concat(pending)); pending = [] }
  }
  for (const record of records) {
    if (record.length < 12) continue
    let seq = Number(record.readBigUInt64LE(0))
    const count = record.readUInt32LE(8)
    let p = 12
    try {
      for (let i = 0; i < count; i++, seq++) {
        const tag = record[p++]
        let len
        ;[len, p] = varint(record, p)
        const key = record.subarray(p, p + len)
        p += len
        let value = null
        if (tag === 1) {
          ;[len, p] = varint(record, p)
          value = record.subarray(p, p + len)
          p += len
        }
        sink(key, seq, tag, value)
      }
    } catch {}
  }
}

export function readLevelDb(dir) {
  const latest = new Map()
  const errors = []
  const sink = (key, seq, type, value) => {
    const id = key.toString('latin1')
    const known = latest.get(id)
    if (!known || seq >= known.seq) latest.set(id, { key: Buffer.from(key), seq, type, value: value ? Buffer.from(value) : null })
  }
  for (const name of readdirSync(dir)) {
    try {
      if (/\.(ldb|sst)$/.test(name)) readTable(readFileSync(join(dir, name)), sink)
      else if (/^\d+\.log$/.test(name)) readLog(readFileSync(join(dir, name)), sink)
    } catch (error) {
      errors.push(`${name}: ${error?.message ?? error}`)
    }
  }
  const entries = []
  for (const item of latest.values()) if (item.type === 1) entries.push({ key: item.key, value: item.value })
  return { entries, errors }
}

function decodeStorageString(buf) {
  if (!buf || buf.length === 0) return ''
  if (buf[0] === 0) return buf.subarray(1).toString('utf16le')
  return buf.subarray(1).toString('latin1')
}

export function readLocalStorage(leveldbDir, { keep = () => true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'yan-ls-'))
  try {
    cpSync(leveldbDir, tmp, { recursive: true, filter: (path) => !/[\\/]LOCK$/.test(path) })
    const { entries, errors } = readLevelDb(tmp)
    const byOrigin = {}
    for (const { key, value } of entries) {
      if (key[0] !== 0x5f) continue
      const split = key.indexOf(0)
      if (split < 0) continue
      const origin = key.subarray(1, split).toString('latin1')
      const name = decodeStorageString(key.subarray(split + 1))
      if (!keep(name, origin)) continue
      ;(byOrigin[origin] ??= {})[name] = decodeStorageString(value)
    }
    return { byOrigin, errors }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
