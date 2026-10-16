import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStyleEntries } from './lib/css-order.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ENTRIES = readStyleEntries(root)
const ORDER = ENTRIES.map((e) => e.name)
const LAYER = new Map(ENTRIES.map((e) => [e.name, e.layer ?? '（未分层）']))

const dir = join(root, 'src/renderer/src/styles')

function selectorsOf(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  let buf = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      const head = buf.trim()
      if (depth === 0 && !head.startsWith('@')) {
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
      buf = ''
    } else {
      if (depth === 0) buf += ch
    }
  }
  return out
}

const stats = []
const owners = new Map()

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

const conflicts = [...owners.entries()]
  .filter(([, files]) => files.length > 1)
  .sort((a, b) => b[1].length - a[1].length)

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
L('> 加载顺序与级联层见 `styles/index.css`：后面的层整体压过前面的层；**同层内同特异性时后加载者胜**。')
L()
L('## 1. 各文件规模')
L()
L('| 顺序 | 文件 | 层 | 行数 | 唯一选择器 | 规则数 | @media | !important |')
L('| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |')
stats.forEach((s, i) => {
  if (s.missing) {
    L(`| ${i + 1} | ${s.name} | ${LAYER.get(s.name)} | — | — | — | — | — |`)
    return
  }
  L(`| ${i + 1} | \`${s.name}\` | ${LAYER.get(s.name)} | ${s.lines} | ${s.uniq} | ${s.total} | ${s.media} | ${s.important} |`)
})
const totalLines = stats.reduce((n, s) => n + (s.lines ?? 0), 0)
const totalUniq = new Set([...owners.keys()]).size
L(`| | **合计** | | **${totalLines}** | **${totalUniq}** | | | |`)
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
const content = out.replace(/\n+$/, '') + '\n'
if (process.argv.includes('--check')) {
  const target = join(root, 'scripts/design/CSS-归属表.md')
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (existing !== content) {
    console.error(`✗ ${target} 与当前样式不一致 —— 跑 npm run measure:css 重新生成`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${target} 与当前样式一致`)
  }
} else if (process.argv.includes('--md')) {
  const target = join(root, 'scripts/design/CSS-归属表.md')
  writeFileSync(target, content, 'utf8')
  console.log(`已写入 ${target}`)
  console.log(`  文件 ${stats.filter((s) => !s.missing).length} 个 / 合计 ${totalLines} 行`)
  console.log(`  唯一选择器 ${totalUniq} 个，其中 ${conflicts.length} 个被 ≥2 个文件定义`)
} else {
  console.log(out)
}
