#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tokens = JSON.parse(readFileSync(join(root, 'src/renderer/src/design/tokens.json'), 'utf8'))

function parseColor(input) {
  const s = String(input).trim()
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  let m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16))
    return { r, g, b, a: 1 }
  }
  m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  throw new Error(`无法解析颜色：${s}`)
}

const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1
})

const lin = (v) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const luminance = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
const contrast = (a, b) => {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
const hex = (c) =>
  '#' +
  [c.r, c.g, c.b]
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')

const MODES = ['light', 'dark']
const roleLabel = { light: '浅色', dark: '深色' }

function tokenColor(name, mode, base) {
  const raw = parseColor(tokens.color[name][mode === 'light' ? 0 : 1])
  if (raw.a >= 1 || !base) return raw
  return over(raw, tokenColor(base, mode))
}

function bgColor(spec, mode) {
  return typeof spec === 'string' ? tokenColor(spec, mode) : tokenColor(spec.tint, mode, spec.over)
}

const MAIN_BASES = [
  'bg',
  'side',
  'surface',
  'surface-3',
  'bubble',
  'sunken',
  { tint: 'hover', over: 'bg' },
  { tint: 'hover', over: 'side' },
  { tint: 'hover', over: 'surface' },
  { tint: 'hover-main', over: 'bg' }
]
const STATUS_BASES = ['bg', 'side', 'surface']

const checks = []
const add = (fg, bases, min, required, note, kind) => {
  for (const bg of bases) checks.push({ fg, bg, min, required, note, kind })
}

add('fg', MAIN_BASES, 4.5, true, '正文')
add('fg2', MAIN_BASES, 4.5, true, '次要文字')
add('fg3', MAIN_BASES, 4.5, true, '元信息/占位')
add('on-ink', ['ink', 'ink-hover'], 4.5, true, '主按钮文字')
add('on-tip', ['tip'], 4.5, true, '提示气泡文字')
add('accent-t', ['bg', 'side', 'surface', 'surface-3'], 4.5, true, '链接/选中文字')
add('run-t', STATUS_BASES, 4.5, true, '运行中文字')
add('ask-t', [...STATUS_BASES, { tint: 'ask-bg', over: 'surface' }, { tint: 'ask-bg', over: 'bg' }], 4.5, true, '待确认文字')
add('stall-t', [...STATUS_BASES, { tint: 'stall-bg', over: 'surface' }, { tint: 'stall-bg', over: 'bg' }], 4.5, true, '停滞文字')
add('fail-t', [...STATUS_BASES, { tint: 'fail-bg', over: 'surface' }, { tint: 'fail-bg', over: 'bg' }], 4.5, true, '失败文字')
add('ok-t', [...STATUS_BASES, { tint: 'ok-bg', over: 'surface' }, { tint: 'ok-bg', over: 'bg' }], 4.5, true, '成功文字')
add('add', [...STATUS_BASES, { tint: 'add-bg', over: 'surface' }, { tint: 'add-bg', over: 'bg' }], 4.5, true, '新增行文字')
add('del', [...STATUS_BASES, { tint: 'del-bg', over: 'surface' }, { tint: 'del-bg', over: 'bg' }], 4.5, true, '删除行文字')

const SEL_BASES = [
  { tint: 'sel', over: 'surface' },
  { tint: 'sel', over: 'bg' },
  { tint: 'sel', over: 'side' }
]
add('fg', SEL_BASES, 4.5, true, '正文·选中')
add('fg2', SEL_BASES, 4.5, true, '次要文字·选中')
add('accent-t', SEL_BASES, 4.5, true, '链接·选中')

add('accent', ['bg', 'side', 'surface', 'surface-3', 'bubble'], 3, true, '焦点环', 'nontext')
add('git-add', ['bg', 'side', 'surface'], 3, true, 'git 新增计数', 'nontext')
add('git-del', ['bg', 'side', 'surface'], 3, true, 'git 删除计数', 'nontext')
for (const dot of ['ok', 'run', 'ask', 'stall', 'fail']) {
  checks.push({ fg: dot, bg: 'bg', min: 3, required: false, waived: true, note: `状态点 ${dot}`, kind: 'nontext' })
  checks.push({ fg: dot, bg: 'side', min: 3, required: false, waived: true, note: `状态点 ${dot}`, kind: 'nontext' })
  checks.push({ fg: dot, bg: 'surface', min: 3, required: false, waived: true, note: `状态点 ${dot}`, kind: 'nontext' })
}
add('ask-edge', STATUS_BASES, 3, true, '待确认状态点描边', 'nontext')
add('line-ctl', ['surface', 'bg', 'side', 'sunken'], 3, true, '控件描边', 'nontext')
add('on-accent', ['accent'], 4.5, true, '强调色底文字')
add('on-find', ['find', 'find-current'], 4.5, true, '查找高亮文字')
for (const tone of ['default', 'green', 'blue', 'yellow', 'orange', 'red', 'purple', 'ink', 'pink', 'teal']) {
  add(`file-${tone}`, ['surface', 'bg', 'side'], 3, true, `文件图标 ${tone}`, 'nontext')
}

const results = []
for (const mode of MODES) {
  for (const c of checks) {
    const bg = bgColor(c.bg, mode)
    const raw = tokenColor(c.fg, mode)
    const fg = raw.a < 1 ? over(raw, bg) : raw
    const ratio = contrast(fg, bg)
    const pass = ratio >= c.min
    const bgName = typeof c.bg === 'string' ? c.bg : `${c.bg.tint}@${c.bg.over}`
    results.push({
      mode,
      id: c.kind === 'nontext' ? `${c.note} [${c.fg} on ${bgName}]` : `${c.fg} on ${bgName}`,
      fgHex: hex(fg),
      bgHex: hex(bg),
      ratio,
      min: c.min,
      pass,
      required: c.required,
      waived: !!c.waived,
      note: c.note
    })
  }
}

if (!process.argv.includes('--json')) {
  for (const mode of MODES) {
    console.log(`\n=== ${roleLabel[mode]} (${mode}) ===`)
    for (const r of results.filter((x) => x.mode === mode)) {
      const tag = r.pass ? 'PASS' : r.waived ? 'FAIL(waived)' : r.required ? 'FAIL' : 'FAIL(report)'
      const mark = r.pass ? ' ' : '!'
      console.log(
        `${mark} ${tag.padEnd(13)} ${r.ratio.toFixed(2).padStart(5)}:1 (≥${r.min})  ${r.id}  ${r.fgHex} on ${r.bgHex}  · ${r.note}`
      )
    }
  }
}

const hardFails = results.filter((r) => !r.pass && r.required)
const waivedFails = results.filter((r) => !r.pass && r.waived)
const reportFails = results.filter((r) => !r.pass && !r.required && !r.waived)
const summary = {
  total: results.length,
  required: results.filter((r) => r.required).length,
  hardFails: hardFails.length,
  waivedFails: waivedFails.length,
  reportFails: reportFails.length
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ results, summary }, null, 2))
  process.exitCode = hardFails.length ? 1 : 0
} else {
console.log(
  `\n共 ${summary.total} 项：必过 ${summary.required}，` +
    `硬性失败 ${summary.hardFails}，状态点豁免失败 ${summary.waivedFails}，报告项失败 ${summary.reportFails}`
)
if (hardFails.length) {
  console.error('\n硬性失败（必须调整令牌，不得隐藏）：')
  for (const r of hardFails) console.error(`  · ${r.mode} ${r.id} = ${r.ratio.toFixed(2)}:1 < ${r.min}`)
  process.exit(1)
}
console.log('对比度检查通过（必过项全部达标）')
}
