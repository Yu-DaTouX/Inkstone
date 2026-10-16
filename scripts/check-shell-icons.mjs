import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')

const failures = []
const notes = []
const ok = (cond, message, detail = '') => {
  if (cond) console.log(`  ✓ ${message}${detail ? '  ' + detail : ''}`)
  else {
    failures.push(message)
    console.log(`  ✗ ${message}${detail ? '  ' + detail : ''}`)
  }
}

function readIcoSizes(file) {
  const buf = readFileSync(file)
  const count = buf.readUInt16LE(4)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    if (off + 16 > buf.length) break
    const w = buf[off] === 0 ? 256 : buf[off]
    const h = buf[off + 1] === 0 ? 256 : buf[off + 1]
    sizes.push(`${w}x${h}`)
  }
  return sizes
}

function readPng(file) {
  const buf = readFileSync(file)
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng) return null
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25]
  }
}

function readBmp(file) {
  const buf = readFileSync(file)
  if (buf.subarray(0, 2).toString('ascii') !== 'BM') return null
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
}

console.log('Windows 外壳图标静态核验\n')

const icoPath = join(buildDir, 'icon.ico')
let icoSizes = []
try {
  icoSizes = readIcoSizes(icoPath)
  console.log(`  icon.ico 尺寸：${icoSizes.join(', ') || '(读不到条目)'}`)
  for (const need of ['16x16', '32x32', '48x48', '256x256']) {
    ok(icoSizes.includes(need), `icon.ico 含 ${need}`)
  }
  ok(!icoSizes.some((s) => /^0x|^-/.test(s)), 'icon.ico 没有坏条目')
} catch (error) {
  ok(false, 'icon.ico 可读', String(error?.message ?? error))
}

try {
  const png = readPng(join(buildDir, 'icon.png'))
  if (!png) ok(false, 'icon.png 是合法 PNG')
  else {
    console.log(`  icon.png：${png.width}×${png.height}，位深 ${png.bitDepth}，colorType ${png.colorType}`)
    ok(png.width >= 256 && png.height >= 256, 'icon.png ≥ 256×256（electron-builder 会用它生成 ico）')
    ok(png.colorType === 6 || png.colorType === 4, 'icon.png 带透明通道（圆角/异形图标不被填成黑底）')
  }
} catch (error) {
  ok(false, 'icon.png 可读', String(error?.message ?? error))
}

try {
  const bmp = readBmp(join(buildDir, 'installerSidebar.bmp'))
  if (!bmp) ok(false, 'installerSidebar.bmp 是合法 BMP')
  else {
    console.log(`  installerSidebar.bmp：${bmp.width}×${bmp.height}`)
    ok(bmp.width === 164 && bmp.height === 314, 'installerSidebar.bmp 是 164×314（NSIS 约束）')
  }
} catch (error) {
  ok(false, 'installerSidebar.bmp 可读', String(error?.message ?? error))
}

const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const explicitIcon = builderConfig
  .split('\n')
  .filter((line) => /^\s*icon\s*:/.test(line))
  .map((line) => line.trim())
ok(
  explicitIcon.every((line) => /icon\.(ico|png)/.test(line)),
  'electron-builder 没有把图标指到 build/ 之外',
  explicitIcon.length ? explicitIcon.join(' / ') : '(走约定路径)'
)

const emptyFiles = readdirSync(buildDir).filter((name) => { const s = statSync(join(buildDir, name)); return s.isFile() && s.size === 0 })
if (emptyFiles.length) {
  notes.push(`build/ 下有 ${emptyFiles.length} 个空文件：${emptyFiles.join('、')}（会被当有效资源打包，建议清掉）`)
}

console.log('')
if (notes.length) {
  console.log('发现（不影响本次核验，但值得处理）：')
  for (const note of notes) console.log(`  · ${note}`)
}
if (failures.length) {
  console.log(`\n✗ ${failures.length} 项未通过：${failures.join('；')}`)
  process.exitCode = 1
} else {
  console.log('✓ 静态部分全部通过（装完之后的观感见包验收单）')
}
