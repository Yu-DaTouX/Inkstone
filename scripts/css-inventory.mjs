/**
 * 样式清单：谁定义了哪些规则、谁覆盖了谁。
 *
 * 用途：P0-1「样式收敛」的**归属表**。10 个 CSS 文件按
 * tokens → app → stage1 → stage2 → redesign → motion → settings →
 * electron → highlight → sidebar-review 顺序加载，最后加载的同特异性规则胜出。
 * 于是「最终效果」不等于「任何单个文件的效果」，而是层层覆盖的结果。
 * 这个脚本把覆盖关系量化出来，迁移时才有依据（而不是凭感觉删）。
 *
 * 用法： node scripts/css-inventory.mjs [--md]
 *   --md  输出 Markdown（可直接贴进设计文档）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 与 App.tsx 的 import 顺序**必须一致** —— 覆盖关系全看它 */
const ORDER = [
  'tokens.css',
  'app.css',
  'stage1.css',
  'stage2.css',
  'redesign.css',
  'motion.css',
  'settings.css',
  'electron.css',
  'highlight.css',
  /* ── 模块化收敛层（最后加载）：原 sidebar-review.css 按模块拆开 ── */
  'layout.css',
  'rail.css',
  'chat.css',
  'tools.css',
  'browser.css'
]

const dir = join(root, 'src/renderer/src/styles')

/**
 * 抽出一个文件里的所有规则选择器。
 *
 * 手写小扫描器而不是正则一把梭：CSS 里 `{}` 是有嵌套的（@media / @keyframes），
 * 正则很容易把 `@media (…)` 的参数当成选择器，或者被 `url(a{b)` 这种内容骗到。
 * 这里只需要「选择器 → 出现次数」，所以按深度跟踪足够了。
 */
function selectorsOf(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '') // 去注释
  const out = []
  let buf = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      const head = buf.trim()
      if (depth === 0 && !head.startsWith('@')) {
        // 顶层规则；逗号分隔的要拆开
        for (const one of head.split(',')) {
          const s = one.replace(/\s+/g, ' ').trim()
          if (s) out.push(s)
        }
      }
      depth++
      buf = ''
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      buf = ''
    } else if (ch === ';' && depth === 0) {
      // @import / @charset 之类
      buf = ''
    } else {
      if (depth === 0) buf += ch
    }
  }
  return out
}

const stats = []
const owners = new Map() // selector → [file, ...]（按加载顺序）

for (const name of ORDER) {
  const p = join(dir, name)
  if (!existsSync(p)) {
    stats.push({ name, missing: true })
    continue
  }
  const src = readFileSync(p, 'utf8')
  const sels = selectorsOf(src)
  const uniq = [...new Set(sels)]
  stats.push({
    name,
    lines: src.split('\n').length,
    bytes: Buffer.byteLength(src),
    total: sels.length,
    uniq: uniq.length,
    media: (src.match(/@media/g) ?? []).length,
    important: (src.match(/!important/g) ?? []).length,
    selectors: uniq
  })
  for (const s of uniq) {
    const arr = owners.get(s) ?? []
    arr.push(name)
    owners.set(s, arr)
  }
}

/* 被多个文件定义的选择器（= 存在覆盖） */
const conflicts = [...owners.entries()]
  .filter(([, files]) => files.length > 1)
  .sort((a, b) => b[1].length - a[1].length)

/* 每个文件「最后一次定义」的 selector 数（即它在覆盖链里的贡献） */
const winsBy = new Map()
for (const [sel, files] of owners) {
  const last = files[files.length - 1]
  winsBy.set(last, (winsBy.get(last) ?? 0) + 1)
}

const md = []
const L = (s = '') => md.push(s)

L('# 样式规则归属表（自动生成）')
L()
L('> 由 `node scripts/css-inventory.mjs --md` 生成。改 CSS 后重新生成再对比。')
L('>')
L('> 加载顺序与 `App.tsx` 的 import 一致；**同特异性时后加载者胜**。')
L()
L('## 1. 各文件规模')
L()
L('| 顺序 | 文件 | 行数 | 唯一选择器 | 规则数 | @media | !important |')
L('| ---: | --- | ---: | ---: | ---: | ---: | ---: |')
stats.forEach((s, i) => {
  if (s.missing) {
    L(`| ${i + 1} | ${s.name} | — | — | — | — | — |`)
    return
  }
  L(`| ${i + 1} | \`${s.name}\` | ${s.lines} | ${s.uniq} | ${s.total} | ${s.media} | ${s.important} |`)
})
const totalLines = stats.reduce((n, s) => n + (s.lines ?? 0), 0)
const totalUniq = new Set([...owners.keys()]).size
L(`| | **合计** | **${totalLines}** | **${totalUniq}** | | | |`)
L()
L('## 2. 覆盖热力：每个文件「最终胜出」的选择器数')
L()
L('即：这些规则是这个文件说了算的（它是最后一个定义者）。')
L()
L('| 文件 | 最终胜出 |')
L('| --- | ---: |')
for (const name of ORDER) {
  if (!stats.find((s) => s.name === name && !s.missing)) continue
  L(`| \`${name}\` | ${winsBy.get(name) ?? 0} |`)
}
L()
L('## 3. 被多个文件定义的选择器（覆盖链）')
L()
L(`共 **${conflicts.length}** 个选择器在 ≥2 个文件里出现。渲染顺序 = 从左到右，**最右那个胜出**。`)
L()
L('| 选择器 | 定义它的文件（按加载顺序） |')
L('| --- | --- |')
for (const [sel, files] of conflicts.slice(0, 120)) {
  L(`| \`${sel}\` | ${files.map((f) => f.replace('.css', '')).join(' → ')} |`)
}
if (conflicts.length > 120) L(`| … | 另有 ${conflicts.length - 120} 个 |`)
L()

const out = md.join('\n')
if (process.argv.includes('--md')) {
  const target = join(root, 'docs/design/CSS-归属表.md')
  writeFileSync(target, out + '\n', 'utf8')
  console.log(`已写入 ${target}`)
  console.log(`  文件 ${stats.filter((s) => !s.missing).length} 个 / 合计 ${totalLines} 行`)
  console.log(`  唯一选择器 ${totalUniq} 个，其中 ${conflicts.length} 个被 ≥2 个文件定义`)
} else {
  console.log(out)
}
