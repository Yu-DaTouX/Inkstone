import { deflateSync, inflateSync } from 'node:zlib'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

export function createImage(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) data.set(fill, index * 4)
  return { width, height, data }
}

export function encodePng(image: RgbaImage): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes)
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') transparency = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR')
  if (interlace) throw new Error('暂不支持隔行扫描 PNG')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`)
  const bitsPerPixel = channels * bitDepth
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0
      const up = prev ? prev[x] : 0
      const upLeft = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0
      const value = line[x]
      out[x] = (filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up : filter === 3 ? value + ((left + up) >> 1) : value + paeth(left, up, upLeft)) & 0xff
    }
  }
  const image = createImage(width, height)
  const sample = (row: Buffer, index: number): number => {
    if (bitDepth === 8) return row[index]
    if (bitDepth === 16) return row[index * 2]
    const perByte = 8 / bitDepth
    const byte = row[Math.floor(index / perByte)]
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    return (byte >> shift) & ((1 << bitDepth) - 1)
  }
  const scale = (value: number): number => (bitDepth >= 8 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1)))
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4
      let rgba: [number, number, number, number]
      if (colorType === 3) {
        const index = sample(row, x)
        rgba = [palette?.[index * 3] ?? 0, palette?.[index * 3 + 1] ?? 0, palette?.[index * 3 + 2] ?? 0, transparency && index < transparency.length ? transparency[index] : 255]
      } else if (colorType === 0) {
        const gray = scale(sample(row, x))
        rgba = [gray, gray, gray, 255]
      } else if (colorType === 4) {
        rgba = [sample(row, x * 2), sample(row, x * 2), sample(row, x * 2), sample(row, x * 2 + 1)]
      } else if (colorType === 2) {
        rgba = [sample(row, x * 3), sample(row, x * 3 + 1), sample(row, x * 3 + 2), 255]
      } else {
        rgba = [sample(row, x * 4), sample(row, x * 4 + 1), sample(row, x * 4 + 2), sample(row, x * 4 + 3)]
      }
      image.data.set(rgba, target)
    }
  }
  return image
}

export function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const index = (y * image.width + x) * 4
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]]
}

export function setPixel(image: RgbaImage, x: number, y: number, rgba: [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  image.data.set(rgba, (y * image.width + x) * 4)
}

export function scaleDown(image: RgbaImage, maxWidth: number): RgbaImage {
  if (image.width <= maxWidth) return image
  const factor = Math.ceil(image.width / maxWidth)
  const width = Math.floor(image.width / factor)
  const height = Math.floor(image.height / factor)
  const out = createImage(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0]
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const index = ((y * factor + dy) * image.width + (x * factor + dx)) * 4
          for (let channel = 0; channel < 4; channel++) sum[channel] += image.data[index + channel]
        }
      }
      out.data.set(sum.map((value) => Math.round(value / (factor * factor))), (y * width + x) * 4)
    }
  }
  return out
}

export function fillRect(image: RgbaImage, x: number, y: number, width: number, height: number, rgba: [number, number, number, number]): void {
  for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) setPixel(image, x + dx, y + dy, rgba)
}
