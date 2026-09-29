/**
 * 手机端令牌同源检查。
 *
 * 手机端（React Native）不能直接读 CSS 变量，`mobile/src/theme.ts` 手写了一份色值。
 * 设计规范 §7 要求它与 `tokens.css` 同名同值：`bg0` ↔ `--bg-0`、`fgDim` ↔ `--fg-dim`。
 * 这里逐项比对深浅两套，改了桌面忘了手机（或反过来）就失败。
 *
 * 用法：node scripts/check-mobile-tokens.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/renderer/src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const ts = readFileSync(join(root, 'mobile/src/theme.ts'), 'utf8')

/** 颜色归一：`#FFF` → `#ffffff`，`rgba(0,0,0,0.10)` → `rgba(0,0,0,0.1)` */
function normColor(v) {
  const s = v.trim().toLowerCase().replace(/\s+/g, '')
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('')
  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (m) return `rgba(${m[1].split(',').map((p) => String(Number(p))).join(',')})`
  return s
}

function cssBlock(theme) {
  const m = new RegExp(`html\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(css)
  if (!m) throw new Error(`tokens.css 里找不到 ${theme} 主题块`)
  const out = new Map()
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim())
  return out
}

function tsBlock(name) {
  const m = new RegExp(`const ${name}: Palette = \\{([^}]*)\\}`).exec(ts)
  if (!m) throw new Error(`theme.ts 里找不到 ${name} 调色板`)
  const out = new Map()
  for (const d of m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) out.set(d[1], d[2])
  return out
}

/** `bg0` → `--bg-0`，`borderSoft` → `--border-soft` */
const cssName = (key) => '--' + key.replace(/([A-Z])/g, '-$1').replace(/(\D)(\d)/g, '$1-$2').toLowerCase()

const problems = []
let compared = 0
for (const theme of ['dark', 'light']) {
  const want = cssBlock(theme)
  for (const [key, value] of tsBlock(theme)) {
    const name = cssName(key)
    const desk = want.get(name)
    if (desk === undefined) {
      problems.push(`${theme} · ${key}：tokens.css 没有 ${name}`)
      continue
    }
    compared++
    if (normColor(desk) !== normColor(value)) problems.push(`${theme} · ${key} = ${value}，桌面 ${name} = ${desk}`)
  }
}

if (problems.length) {
  console.error(`✗ 手机令牌与桌面不一致（${problems.length} 处）：`)
  for (const p of problems) console.error('   ' + p)
  console.error('  改 mobile/src/theme.ts 或 tokens.css，让两边同名同值（设计规范 §7）。')
  process.exit(1)
}
console.log(`✓ 手机令牌与桌面同源 · ${compared} 项`)
