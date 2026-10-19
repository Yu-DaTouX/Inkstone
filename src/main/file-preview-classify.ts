import { extname } from 'node:path'
import type { FilePreviewEncoding, FilePreviewMedia } from '../shared/ipc'

const MEDIA_BY_EXT: Record<string, FilePreviewMedia> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
  '.svg': 'image', '.ico': 'image', '.avif': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video', '.mkv': 'video', '.avi': 'video', '.ogv': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.oga': 'audio', '.flac': 'audio', '.m4a': 'audio', '.aac': 'audio', '.opus': 'audio',
  '.pdf': 'pdf'
}

export const BINARY_SNIFF_BYTES = 8000

export function mediaOf(name: string): FilePreviewMedia | undefined {
  return MEDIA_BY_EXT[extname(name).toLowerCase()]
}

export interface DecodedText {
  text: string
  encoding: FilePreviewEncoding
  issue?: 'binary' | 'encoding'
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function decodePrefix(label: string, bytes: Uint8Array, complete: boolean): string | null {
  const whole = tryDecode(label, bytes)
  if (whole !== null || complete) return whole
  for (let cut = 1; cut <= 3 && cut < bytes.length; cut += 1) {
    const partial = tryDecode(label, bytes.subarray(0, bytes.length - cut))
    if (partial !== null) return partial
  }
  return null
}

export function decodeText(bytes: Uint8Array, complete = true): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = decodePrefix('utf-8', bytes.subarray(3), complete)
    if (text !== null) return { text, encoding: 'utf8-bom' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const decoded = tryDecode('utf-16be', bytes.subarray(2))
    if (decoded !== null) return { text: decoded, encoding: 'utf16be' }
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { text: '', encoding: 'unknown', issue: 'binary' }
  const utf8 = decodePrefix('utf-8', bytes, complete)
  if (utf8 !== null) return { text: utf8, encoding: 'utf8' }
  const gb = decodePrefix('gb18030', bytes, complete)
  if (gb !== null) return { text: gb, encoding: 'gb18030' }
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'unknown', issue: 'encoding' }
}
