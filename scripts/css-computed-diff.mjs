/**
 * 比较两批视觉矩阵的逐元素计算样式（`YAN_STYLE_DUMP=1` 产出的 *.styles.json）。
 *
 * 用途：样式结构重构（级联层、拆文件、令牌替换）承诺「看起来一模一样」。
 * `css-layer-check.mjs` 只能证明**同一选择器**的声明不变，证明不了选择器之间
 * 的特异性与层序关系；截图差异又说不出是哪个元素。这里直接比浏览器算出来的结果。
 *
 * 用法：
 *   node scripts/css-computed-diff.mjs <前一批目录> <后一批目录> [--ignore opacity,transform] [--limit 40]
 *
 * 输出按「类名 · 属性 · 前 → 后」聚合，同一处变化在多张图里出现只列一次并计数。
 * 运行中的循环动画（方点阵、流光）会让 opacity / transform 抖动，可用 --ignore 排除。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const [dirA, dirB] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'))
if (!dirA || !dirB) {
  console.error('用法: node scripts/css-computed-diff.mjs <前一批目录> <后一批目录> [--ignore p1,p2] [--limit n]')
  process.exit(2)
}
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const ignore = new Set((opt('--ignore', '') || '').split(',').filter(Boolean))
const limit = Number(opt('--limit', '60'))

const groups = new Map()
let files = 0
let elements = 0
let missing = 0
const bump = (key, where) => {
  const g = groups.get(key) ?? { n: 0, where: new Set() }
  g.n++
  if (g.where.size < 4) g.where.add(where)
  groups.set(key, g)
}

const compareStyle = (a, b, cls, where, pe = '') => {
  if (!a && !b) return
  if (!a || !b) {
    bump(`${cls}${pe} · ${a ? '伪元素消失' : '伪元素新增'}`, where)
    return
  }
  if (a['#'] === b['#']) return
  let named = false
  for (const p of Object.keys(a)) {
    if (p === '#' || ignore.has(p) || a[p] === b[p]) continue
    named = true
    bump(`${cls}${pe} · ${p}: ${a[p]} → ${b[p]}`, where)
  }
  if (!named && ![...ignore].length) bump(`${cls}${pe} · （常用属性之外的差异）`, where)
}

for (const f of readdirSync(dirA).filter((x) => x.endsWith('.styles.json')).sort()) {
  const pb = join(dirB, f)
  if (!existsSync(pb)) {
    console.log(`缺少后一批：${f}`)
    continue
  }
  files++
  const A = JSON.parse(readFileSync(join(dirA, f), 'utf8'))
  const B = JSON.parse(readFileSync(pb, 'utf8'))
  const where = f.replace(/^matrix-/, '').replace(/\.styles\.json$/, '')
  for (const [key, ea] of Object.entries(A)) {
    const eb = B[key]
    if (!eb) {
      missing++
      continue
    }
    elements++
    const cls = (ea.cls || key.split('>').pop()).trim().split(/\s+/).slice(0, 3).map((c) => (c.includes(':') ? c : '.' + c)).join('')
    compareStyle(ea.s, eb.s, cls, where)
    compareStyle(ea['::before'], eb['::before'], cls, where, '::before')
    compareStyle(ea['::after'], eb['::after'], cls, where, '::after')
  }
}

const rows = [...groups.entries()].sort((x, y) => y[1].n - x[1].n)
for (const [key, g] of rows.slice(0, limit)) console.log(`${String(g.n).padStart(5)}  ${key}   [${[...g.where].join(', ')}]`)
if (rows.length > limit) console.log(`  … 另有 ${rows.length - limit} 类差异（--limit 调整）`)
console.log(`\n比较 ${files} 张图、${elements} 个元素；前后结构不同未比较 ${missing} 个元素`)
if (rows.length === 0) console.log('✓ 计算样式一致')
process.exit(rows.length ? 1 : 0)
