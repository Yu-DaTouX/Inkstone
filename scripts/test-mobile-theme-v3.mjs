import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const themeV3Path = fileURLToPath(new URL('../mobile/src/theme-v3.ts', import.meta.url))
const generatedPath = fileURLToPath(new URL('../mobile/src/theme.v3.generated.ts', import.meta.url))
const themeTsPath = fileURLToPath(new URL('../mobile/src/theme.ts', import.meta.url))

async function loadTs(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const v3 = await loadTs(themeV3Path)
const gen = await loadTs(generatedPath)

assert.equal(v3.THEME_V3_ENABLED, false, 'THEME_V3_ENABLED 必须默认 false，手机端保持旧色板')
assert.equal(v3.v3Palette('light'), v3.v3PaletteLight, "v3Palette('light') 应返回浅色 v3 色板")
assert.equal(v3.v3Palette('dark'), v3.v3PaletteDark, "v3Palette('dark') 应返回深色 v3 色板")

const themeTs = readFileSync(themeTsPath, 'utf8')
const paletteBody = /export interface Palette \{([\s\S]*?)\}/.exec(themeTs)
assert.ok(paletteBody, 'theme.ts 里找不到 Palette 接口')
const declared = [...paletteBody[1].matchAll(/^\s*(\w+)(\?)?\s*:/gm)].map((m) => m[1])
assert.ok(declared.length > 10, `Palette 接口键太少，疑似解析失败：${declared.join(', ')}`)

for (const [name, palette] of [
  ['v3PaletteLight', v3.v3PaletteLight],
  ['v3PaletteDark', v3.v3PaletteDark]
]) {
  for (const key of declared) {
    const value = palette[key]
    assert.equal(typeof value, 'string', `${name}.${key} 缺失或不是字符串`)
    assert.ok(value.length > 0, `${name}.${key} 为空值`)
  }
}

const mapping = (c) => ({
  bg0: c.bg,
  bg1: c.side,
  bg2: c.surface,
  bg3: c.hover,
  border: c.line2,
  borderSoft: c.line,
  borderStr: c.line2,
  fg: c.fg,
  fgDim: c.fg2,
  fgMute: c.fg3,
  accent: c.accent,
  accentSoft: c.sel,
  accentLine: c.accent,
  onAccent: c.onInk,
  ok: c.runT,
  warn: c.askT,
  warnSoft: c.askBg,
  err: c.failT,
  errSoft: c.failBg,
  ink: c.ink,
  inkHover: c.inkHover,
  onInk: c.onInk
})

for (const [name, palette, tokens] of [
  ['v3PaletteLight', v3.v3PaletteLight, gen.v3Light],
  ['v3PaletteDark', v3.v3PaletteDark, gen.v3Dark]
]) {
  const want = mapping(tokens)
  for (const [key, value] of Object.entries(want)) {
    assert.equal(palette[key], value, `${name}.${key} 应等于生成令牌，实际 ${palette[key]}，期望 ${value}`)
  }
  const extra = Object.keys(palette).filter((k) => !(k in want))
  assert.deepEqual(extra, [], `${name} 出现映射表以外的键：${extra.join(', ')}`)
}

function parseColor(input) {
  const s = String(input).trim()
  let m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  throw new Error(`无法解析颜色：${s}`)
}
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

const textPairs = (p) => [
  [p.fg, p.bg0, '正文 / 对话区'],
  [p.fg, p.bg1, '正文 / 侧栏'],
  [p.fg, p.bg2, '正文 / 卡片'],
  [p.fgDim, p.bg0, '次要文字 / 对话区'],
  [p.fgDim, p.bg1, '次要文字 / 侧栏'],
  [p.fgDim, p.bg2, '次要文字 / 卡片'],
  [p.fgMute, p.bg0, '元信息 / 对话区'],
  [p.fgMute, p.bg1, '元信息 / 侧栏'],
  [p.fgMute, p.bg2, '元信息 / 卡片'],
  [p.onInk, p.ink, '主按钮文字 / 墨色底'],
  [p.accent, p.bg0, '链接 / 对话区'],
  [p.ok, p.bg0, '运行中文字 / 对话区'],
  [p.warn, p.bg0, '等你确认文字 / 对话区'],
  [p.err, p.bg0, '失败文字 / 对话区']
]

let checked = 0
for (const [label, palette] of [
  ['浅色', v3.v3PaletteLight],
  ['深色', v3.v3PaletteDark]
]) {
  for (const [fg, bg, name] of textPairs(palette)) {
    const ratio = contrast(parseColor(fg), parseColor(bg))
    assert.ok(ratio >= 4.5, `${label} ${name}：对比度 ${ratio.toFixed(2)}:1 < 4.5`)

    checked++
  }
}

console.log(`✓ 手机端 v3 令牌映射检查通过 · ${declared.length} 个 Palette 键 × 2 主题，${checked} 组对比度 ≥4.5:1（默认开关 false，外观不变）`)
