/**
 * 样式防回退：几项「只许下降」的计数（界面重构计划 §5）。
 *
 *   straysPx      模块 CSS 里写死的 px（不含 0 / 1px 发丝线 / 百分比，统计口径同 css-drift）
 *   important     `!important` 声明数
 *   privateCtl    模块自建的控件类（`.xxx-btn` / `.xxx-chip` / `.xxx-tab`，ui.css 之外定义）
 *
 * 基线在 scripts/design/css-budget.json。数值上升即失败；下降时提示用
 * `--update` 把基线收紧到当前值，免得后面的改动悄悄把省下的额度用回去。
 *
 * 用法：node scripts/check-css-budget.mjs [--update]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStyleOrder, stylesDir } from './lib/css-order.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = stylesDir(root)
const budgetFile = join(root, 'scripts/design/css-budget.json')

/** 语法色板与令牌定义处不计：它们本来就是值的真源 */
const EXEMPT = new Set(['highlight.css', 'tokens.css'])
const IGNORED = new Set(['0px', '1px'])
const PX = /(?<![\w.-])\d*\.?\d+px\b/g
const DECL = /([-\w]+)\s*:\s*([^;{}]+)(?=[;}])/g
const CTL = /\.([a-z][\w-]*-(?:btn|chip|tab))(?![\w-])/g

function measure() {
  let straysPx = 0
  let important = 0
  const ctl = new Set()
  /* ui.css 自己定义的控件类（如 .seg-btn）在模块里出现只是摆位置，不算私有控件 */
  const uiCss = readFileSync(join(dir, 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '{}')
  const shared = new Set([...uiCss.matchAll(CTL)].map((m) => m[1]))
  for (const name of readStyleOrder(root)) {
    const css = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    important += (css.match(/!\s*important/gi) ?? []).length
    if (name !== 'ui.css') {
      /* 只看选择器部分：去掉声明块内容后再找类名 */
      const selectors = css.replace(/\{[^{}]*\}/g, '{}')
      for (const m of selectors.matchAll(CTL)) if (!shared.has(m[1])) ctl.add(m[1])
    }
    if (EXEMPT.has(name)) continue
    for (const m of css.matchAll(DECL)) {
      if (m[1].startsWith('--')) continue
      for (const v of m[2].match(PX) ?? []) if (!IGNORED.has(v)) straysPx++
    }
  }
  return { straysPx, important, privateCtl: ctl.size }
}

const now = measure()
const base = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, 'utf8')) : null

if (process.argv.includes('--update') || !base) {
  writeFileSync(budgetFile, JSON.stringify(now, null, 2) + '\n')
  console.log(`已写入基线 ${budgetFile}：${JSON.stringify(now)}`)
  process.exit(0)
}

const worse = Object.keys(now).filter((k) => now[k] > (base[k] ?? Infinity))
const better = Object.keys(now).filter((k) => now[k] < (base[k] ?? Infinity))
for (const k of Object.keys(now)) console.log(`  ${k.padEnd(11)} ${String(now[k]).padStart(5)}  （基线 ${base[k]}）`)
if (worse.length) {
  console.error(`✗ 样式预算上升：${worse.join('、')}。改用令牌或统一控件，别新增散落值与私有控件。`)
  process.exit(1)
}
if (better.length) console.log(`✓ 样式预算下降（${better.join('、')}）—— 跑 node scripts/check-css-budget.mjs --update 收紧基线`)
else console.log('✓ 样式预算未上升')
