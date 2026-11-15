export type ThinkingBlockKind = 'narration' | 'thinking' | 'unknown'

const PREFIX_BYTES = 512
const MAX_SIGNATURE_CHARS = 4 * 1024 * 1024
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  return table
})()
const KIND_PATH = [2, 1, 8] as const
const NARRATION = 'narration'
const THINKING = 'thinking'
const MORE = -2

function decodedLength(signature: string): number {
  if (signature.length % 4 === 1) return -1
  const pad = signature.endsWith('==') ? 2 : signature.endsWith('=') ? 1 : 0
  const body = signature.length - pad
  if (pad && signature.length % 4 !== 0) return -1
  return Math.floor((body * 6) / 8)
}

function decodeBase64(signature: string, maxBytes: number): Uint8Array {
  const total = Math.min(maxBytes, decodedLength(signature))
  const out = new Uint8Array(total)
  let buffer = 0
  let bits = 0
  let written = 0
  for (let i = 0; i < signature.length && written < total; i++) {
    const value = LOOKUP[signature.charCodeAt(i)]
    if (value < 0) break
    buffer = ((buffer << 6) | value) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[written++] = (buffer >> bits) & 0xff
    }
  }
  return out
}

interface Span {
  start: number
  end: number
}

function readVarint(bytes: Uint8Array, at: number, end: number): { value: number; next: number } | number {
  let value = 0
  let scale = 1
  for (let i = 0; i < 10; i++) {
    const pos = at + i
    if (pos >= end) return -1
    if (pos >= bytes.length) return MORE
    const byte = bytes[pos]
    value += (byte & 0x7f) * scale
    if (value > Number.MAX_SAFE_INTEGER) return -1
    if (byte < 0x80) return { value, next: pos + 1 }
    scale *= 128
  }
  return -1
}

function findField(bytes: Uint8Array, span: Span, field: number, wantLast: boolean): Span | null | number {
  let at = span.start
  let found: Span | null = null
  while (at < span.end) {
    const key = readVarint(bytes, at, span.end)
    if (typeof key === 'number') return key
    const number = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (number === 0) return -1
    at = key.next
    if (wire === 0) {
      const skipped = readVarint(bytes, at, span.end)
      if (typeof skipped === 'number') return skipped
      at = skipped.next
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      if (at > span.end) return -1
    } else if (wire === 2) {
      const length = readVarint(bytes, at, span.end)
      if (typeof length === 'number') return length
      const start = length.next
      const end = start + length.value
      if (end > span.end) return -1
      if (number === field) {
        found = { start, end }
        if (!wantLast) return found
      }
      at = end
    } else {
      return -1
    }
  }
  return found
}

function asciiEquals(bytes: Uint8Array, span: Span, text: string): boolean {
  if (span.end - span.start !== text.length) return false
  for (let i = 0; i < text.length; i++) if (bytes[span.start + i] !== text.charCodeAt(i)) return false
  return true
}

function kindFromBytes(bytes: Uint8Array, total: number): ThinkingBlockKind | number {
  let span: Span = { start: 0, end: total }
  for (let depth = 0; depth < KIND_PATH.length; depth++) {
    const found = findField(bytes, span, KIND_PATH[depth], depth === KIND_PATH.length - 1)
    if (found === null) return 'unknown'
    if (typeof found === 'number') return found
    span = found
  }
  if (span.end > bytes.length) return MORE
  if (asciiEquals(bytes, span, NARRATION)) return 'narration'
  if (asciiEquals(bytes, span, THINKING)) return 'thinking'
  return 'unknown'
}

export function signatureKind(signature: unknown): ThinkingBlockKind {
  if (typeof signature !== 'string' || signature.length < 4 || signature.length > MAX_SIGNATURE_CHARS) return 'unknown'
  if (!BASE64_SHAPE.test(signature)) return 'unknown'
  const total = decodedLength(signature)
  if (total <= 0) return 'unknown'
  let result = kindFromBytes(decodeBase64(signature, PREFIX_BYTES), total)
  if (result === MORE && total > PREFIX_BYTES) result = kindFromBytes(decodeBase64(signature, total), total)
  return typeof result === 'number' ? 'unknown' : result
}

export function thinkingBlockKind(block: unknown): ThinkingBlockKind {
  if (!block || typeof block !== 'object') return 'unknown'
  const record = block as { type?: unknown; redacted?: unknown; thinkingSignature?: unknown }
  if (record.type !== 'thinking' || record.redacted === true) return 'unknown'
  return signatureKind(record.thinkingSignature)
}

export function isNarrationBlock(block: unknown): boolean {
  return thinkingBlockKind(block) === 'narration'
}

export function visibleTextOfBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const record = block as { type?: unknown; text?: unknown; thinking?: unknown }
  if (record.type === 'text') return typeof record.text === 'string' ? record.text : ''
  if (record.type === 'thinking' && isNarrationBlock(block)) return typeof record.thinking === 'string' ? record.thinking : ''
  return null
}
