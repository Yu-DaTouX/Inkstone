import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type, body) {
  const head = Buffer.from(type, 'latin1')
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  head.copy(out, 4)
  body.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([head, body])), 8 + body.length)
  return out
}

export function pngBytes(tag, size = 1) {
  const seed = [...Buffer.from(String(tag))].reduce((sum, byte) => (sum * 31 + byte) >>> 0, 7)
  const pixel = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255]
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => pixel).flat())])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export function pngImage(tag, size = 1) {
  return { data: pngBytes(tag, size).toString('base64'), mimeType: 'image/png' }
}
