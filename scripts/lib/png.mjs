import { crc32, deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件')
  let offset = 8
  let header = null
  let palette = null
  let transparency = null
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] }
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') transparency = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('PNG 缺少 IHDR')
  const { width, height, depth, colorType, interlace } = header
  if (depth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) throw new Error(`不支持的 PNG 格式：depth=${depth} colorType=${colorType} interlace=${interlace}`)
  const channels = CHANNELS[colorType]
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(data))
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = rows.subarray(y * stride, (y + 1) * stride)
    const prev = y ? rows.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0
      const up = prev ? prev[x] : 0
      const corner = prev && x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, corner)
      out[x] = value & 255
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    if (colorType === 6) {
      rgba[o] = rows[i * 4]; rgba[o + 1] = rows[i * 4 + 1]; rgba[o + 2] = rows[i * 4 + 2]; rgba[o + 3] = rows[i * 4 + 3]
    } else if (colorType === 2) {
      rgba[o] = rows[i * 3]; rgba[o + 1] = rows[i * 3 + 1]; rgba[o + 2] = rows[i * 3 + 2]; rgba[o + 3] = 255
    } else if (colorType === 3) {
      const index = rows[i]
      rgba[o] = palette[index * 3]; rgba[o + 1] = palette[index * 3 + 1]; rgba[o + 2] = palette[index * 3 + 2]
      rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255
    } else if (colorType === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = rows[i * 2]; rgba[o + 3] = rows[i * 2 + 1]
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = rows[i]; rgba[o + 3] = 255
    }
  }
  return { width, height, data: rgba }
}

export function encodePng({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const line = data.subarray(y * stride, (y + 1) * stride)
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : null
    const plain = Buffer.from(line)
    const predicted = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? line[x - 4] : 0
      const up = prev ? prev[x] : 0
      const corner = prev && x >= 4 ? prev[x - 4] : 0
      predicted[x] = (line[x] - paeth(left, up, corner)) & 255
    }
    const usePaeth = cost(predicted) < cost(plain)
    raw[y * (stride + 1)] = usePaeth ? 4 : 0
    ;(usePaeth ? predicted : plain).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

export function resample(image, width, height = width) {
  const out = new Uint8ClampedArray(width * height * 4)
  const sx = image.width / width
  const sy = image.height / height
  for (let y = 0; y < height; y++) {
    const y0 = y * sy
    const y1 = y0 + sy
    for (let x = 0; x < width; x++) {
      const x0 = x * sx
      const x1 = x0 + sx
      let r = 0, g = 0, b = 0, a = 0, area = 0
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py)
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const w = (Math.min(x1, px + 1) - Math.max(x0, px)) * wy
          const o = (py * image.width + px) * 4
          const alpha = image.data[o + 3] * w
          r += image.data[o] * alpha; g += image.data[o + 1] * alpha; b += image.data[o + 2] * alpha
          a += alpha; area += w
        }
      }
      const o = (y * width + x) * 4
      out[o] = a ? r / a : 0
      out[o + 1] = a ? g / a : 0
      out[o + 2] = a ? b / a : 0
      out[o + 3] = area ? a / area : 0
    }
  }
  return { width, height, data: out }
}

export function pngDataUrl(image) {
  return `data:image/png;base64,${encodePng(image).toString('base64')}`
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function cost(line) {
  let sum = 0
  for (const v of line) sum += v < 128 ? v : 256 - v
  return sum
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, tail])
}
