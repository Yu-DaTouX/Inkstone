/**
 * Windows 外壳 / 安装器图标的**静态**核验（实施-11 H-8 的包侧，2026-09-23）。
 *
 * 为什么需要它：外壳图标（任务栏、开始菜单、安装器、卸载器）只有在**装完之后**
 * 才看得见，而按规范「暂无发布计划时不为了这片自动重打全部安装包」。
 * 于是把**能静态核对的部分**先钉住 —— 资源本身对不对、尺寸齐不齐、
 * 配置有没有走偏；真正装完之后的观感留给包验收单。
 *
 * 检查项：
 *   ① `build/icon.ico` 里有哪些尺寸（Windows 小到 16×16 的列表图标、大到 256×256 都从它取）；
 *   ② `build/icon.png` 的像素尺寸与是否带透明通道；
 *   ③ `build/installerSidebar.bmp` 是不是 NSIS 要求的 164×314；
 *   ④ electron-builder 配置里有没有人显式覆盖了图标；
 *   ⑤ `build/` 下有没有**空文件**（会被当作有效资源打包，出问题时极难查）。
 *
 * 用法： node scripts/check-shell-icons.mjs
 */
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

/** ICO：6 字节头 + 每个条目 16 字节；宽/高为 0 表示 256 */
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

/** PNG：IHDR 的宽高是 big-endian；colorType 6/4 带 alpha */
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

/** BMP：宽/高在 18 / 22（little-endian），高度为负表示自上而下 */
function readBmp(file) {
  const buf = readFileSync(file)
  if (buf.subarray(0, 2).toString('ascii') !== 'BM') return null
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
}

console.log('Windows 外壳图标静态核验\n')

/* ---- ① icon.ico ---- */
const icoPath = join(buildDir, 'icon.ico')
let icoSizes = []
try {
  icoSizes = readIcoSizes(icoPath)
  console.log(`  icon.ico 尺寸：${icoSizes.join(', ') || '(读不到条目)'}`)
  /*
   * Windows 实际会用到这几档：16/20（任务栏与列表）、32（开始菜单）、
   * 48（桌面）、256（大图标 / 高 DPI）。缺小尺寸会被系统拉伸得发糊。
   */
  for (const need of ['16x16', '32x32', '48x48', '256x256']) {
    ok(icoSizes.includes(need), `icon.ico 含 ${need}`)
  }
  ok(!icoSizes.some((s) => /^0x|^-/.test(s)), 'icon.ico 没有坏条目')
} catch (error) {
  ok(false, 'icon.ico 可读', String(error?.message ?? error))
}

/* ---- ② icon.png ---- */
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

/* ---- ③ 安装器侧栏 ---- */
try {
  const bmp = readBmp(join(buildDir, 'installerSidebar.bmp'))
  if (!bmp) ok(false, 'installerSidebar.bmp 是合法 BMP')
  else {
    console.log(`  installerSidebar.bmp：${bmp.width}×${bmp.height}`)
    /* NSIS 的 MUI_WELCOMEFINISHPAGE_BITMAP 约束；不对会被拉伸得发糊 */
    ok(bmp.width === 164 && bmp.height === 314, 'installerSidebar.bmp 是 164×314（NSIS 约束）')
  }
} catch (error) {
  ok(false, 'installerSidebar.bmp 可读', String(error?.message ?? error))
}

/* ---- ④ 配置有没有被覆盖 ---- */
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

/* ---- ⑤ 空文件 ---- */
const emptyFiles = readdirSync(buildDir).filter((name) => statSync(join(buildDir, name)).size === 0)
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
