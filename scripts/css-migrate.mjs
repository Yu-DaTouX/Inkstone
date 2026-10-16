import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStyleOrder } from './lib/css-order.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/src/styles')

const ORDER = readStyleOrder(root)

function maskComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function scanTopLevel(cssRaw) {
  const css = maskComments(cssRaw)
  const blocks = []
  let depth = 0
  let headStart = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      const head = css.slice(headStart, i)
      if (depth === 0 && !head.trim().startsWith('@') && head.trim()) {
        let d = 1
        let j = i + 1
        for (; j < css.length && d > 0; j++) {
          if (css[j] === '{') d++
          else if (css[j] === '}') d--
        }
        blocks.push({ start: headStart, end: j, head })
        i = j - 1
        headStart = j
        continue
      }
      depth++
      headStart = i + 1
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      headStart = i + 1
      continue
    }
    if (ch === ';' && depth === 0) headStart = i + 1
  }
  return blocks
}

const selsOf = (head) =>
  head
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

function ownerMap() {
  const owners = new Map()
  for (const f of ORDER) {
    let src
    try {
      src = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const b of scanTopLevel(src)) {      for (const s of selsOf(b.head)) {
        const a = owners.get(s) ?? []
        if (!a.includes(f)) a.push(f)
        owners.set(s, a)
      }
    }
  }
  return owners
}

const argv = process.argv.slice(2)
const arg = (name, def = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}
const from = arg('--from')
const to = arg('--to')
const matches = argv.reduce((acc, a, i) => (a === '--match' ? [...acc, argv[i + 1]] : acc), [])
const dry = argv.includes('--dry')
const allowShared = argv.includes('--all')

if (!from || !to || matches.length === 0) {
  console.error('用法: node scripts/css-migrate.mjs --from redesign.css --to tools.css --match ".rp-" [--dry] [--all]')
  process.exit(2)
}

const owners = ownerMap()
const srcPath = join(dir, from)
const src = readFileSync(srcPath, 'utf8')
const blocks = scanTopLevel(src)

const selCount = new Map()
for (const b of blocks) {
  for (const s of selsOf(b.head)) selCount.set(s, (selCount.get(s) ?? 0) + 1)
}

const hit = []
const skippedShared = []
const skippedDup = []
for (const b of blocks) {
  const sels = selsOf(b.head)
  if (sels.length === 0) continue
  if (!sels.every((s) => matches.some((m) => s.startsWith(m)))) continue
  const shared = sels.filter((s) => (owners.get(s) ?? []).length > 1)
  if (shared.length > 0 && !allowShared) {
    skippedShared.push({ block: sels[0], shared })
    continue
  }
  const dup = sels.filter((s) => (selCount.get(s) ?? 0) > 1)
  if (dup.length > 0 && !allowShared) {
    skippedDup.push({ block: sels[0], dup })
    continue
  }
  hit.push(b)
}

for (const b of hit) {
  let p = b.start
  while (p > 0 && /\s/.test(src[p - 1])) p--
  if (src.slice(Math.max(0, p - 2), p) === '*/') {
    const open = src.lastIndexOf('/*', p)
    if (open >= 0) b.start = open
  }
}

const ranges = hit.map((b) => [b.start, b.end]).sort((a, b) => a[0] - b[0])
let outSrc = ''
let cursor = 0
for (const [s, e] of ranges) {
  outSrc += src.slice(cursor, s)
  cursor = e
}
outSrc += src.slice(cursor)
outSrc = outSrc.replace(/\n{3,}/g, '\n\n')

const movedText = ranges.map(([s, e]) => src.slice(s, e).trim()).join('\n\n')

const mediaMatch = (src.match(/@media[\s\S]*?\n\}/g) ?? []).filter((m) =>
  matches.some((p) => m.includes(p))
).length

console.log(`源文件 ${from}：共 ${blocks.length} 个顶层规则`)
console.log(`  命中前缀 ${matches.join(', ')}：${hit.length} 个块`)
if (skippedShared.length) {
  console.log(`  跳过（选择器被其他文件也定义，平移会改变层叠）：${skippedShared.length} 个`)
  for (const s of skippedShared.slice(0, 8)) console.log(`    · ${s.block}  ← ${s.shared.join(',')}`)
}
if (skippedDup.length) {
  console.log(`  跳过（选择器在本文件里有重复定义，需先归并）：${skippedDup.length} 个`)
  for (const s of skippedDup.slice(0, 8)) console.log(`    · ${s.block}  ← ${s.dup.join(',')}`)
}
console.log(`  @media 内的匹配块（未迁移，需手工）：约 ${mediaMatch} 处`)

if (dry) {
  console.log('\n--dry：未写文件')
  process.exit(0)
}

if (hit.length === 0) {
  console.log('\n没有可迁移的块')
  process.exit(0)
}

writeFileSync(srcPath, outSrc, 'utf8')
const toPath = join(dir, to)
const prev = readFileSync(toPath, 'utf8')
const banner = `\n\n/* ══════════════════════════════════════════════════════════════\n   以下从 ${from} 迁入（P0-1 样式收敛：按模块归位，只搬家不改值）\n   ══════════════════════════════════════════════════════════════ */\n\n`
writeFileSync(toPath, prev.replace(/\s*$/, '') + banner + movedText + '\n', 'utf8')
console.log(`\n✓ 已迁 ${hit.length} 个块：${from} → ${to}`)
console.log('  接下来务必跑：node scripts/css-layer-check.mjs <迁移前的 styles 快照> src/renderer/src/styles')
