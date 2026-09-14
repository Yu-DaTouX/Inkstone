/**
 * CSS 规则迁移工具（P0-1 样式收敛用）。
 *
 * 把**独占**的选择器规则从一个文件搬到另一个文件 —— 「只搬家、不改值」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须限定「独占」
 * ══════════════════════════════════════════════════════════════════
 * 样式靠「后加载者胜」层叠。把一条规则从中间层（redesign）搬到最后一层
 * （rail/tools/…）会**改变它的胜负关系** —— 原来被它覆盖的规则现在反过来
 * 覆盖它。所以只有「全工程只有这一个文件定义它」的选择器才能安全平移。
 * 这类选择器在 redesign.css 里占 604/724，迁移空间足够。
 *
 * 用法：
 *   node scripts/css-migrate.mjs --from redesign.css --to tools.css --match ".rp-" [--dry] [--all]
 *
 *   --match <前缀>  选择器以此开头才迁（可重复传多个）
 *   --all           连非独占的也迁（危险，仅在你已确认层叠不变时用）
 *   --dry           只报告，不写文件
 *
 * @media 里的规则**不迁**（会单独报告）—— 它们要跟媒体查询一起走，
 * 混在一起做容易出错，留给你手工搬。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/src/styles')

/** 与 App.tsx 的 import 顺序一致（算「独占」要看全部文件） */
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
  'layout.css',
  'rail.css',
  'chat.css',
  'tools.css',
  'browser.css'
]

/**
 * 抽出顶层规则块（跳过 @media 等 at-rule 内部）。
 *
 * ⚠️ 先把注释屏蔽掉，但**保留长度**（只把非换行字符换成空格）。
 *    不这么做的话，前面带注释的规则 head 会变成
 *    `/* 57. 任务栏 … *\/  .rp-meter`，拿它当选择器去比对就永远对不上 ——
 *    owners 判断失真，会把「其实被 motion.css 也定义」的选择器
 *    误当成独占迁走。实测就是因此产生了 4 处层叠变化。
 *    保留长度是为了后面用下标切片取原文（注释要随规则一起搬走）。
 */
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

/** 每个选择器由哪些文件定义 */
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

/* ---- 参数 ---- */
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

/**
 * 命中：块里**所有**选择器都匹配前缀，且这些选择器**在源文件内部也只出现一次**。
 *
 * ⚠️ 为什么「源文件内唯一」是必需的（踩过的坑）：
 *   redesign.css 是多次评审叠加的，同一个选择器常有**新旧两条**定义
 *   （如 `.rp-meter` 出现 3 次，靠后那条胜）。如果只迁走其中一部分
 *   （比如另一条在混合块里、前缀不完全匹配而被留下），层叠关系就变了：
 *   原来「靠后的旧定义胜」，迁移后变成「搬到最后一层的那条胜」。
 *   实测一次就产生了 6 处真实的样式变化，是 css-layer-check 报出来的。
 *
 *   所以：源文件里有重复定义的选择器先不动 —— 它们需要的是「先归并重复定义」
 *   （P0-1 的下一步），而不是搬家。
 */
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

/* 把块前面紧邻的注释一起带走（否则源文件里剩一堆孤儿注释） */
for (const b of hit) {
  let p = b.start
  while (p > 0 && /\s/.test(src[p - 1])) p--
  if (src.slice(Math.max(0, p - 2), p) === '*/') {
    const open = src.lastIndexOf('/*', p)
    if (open >= 0) b.start = open
  }
}

/* 重建源文件（去掉命中的区间） */
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

/* @media 里还有多少匹配的规则没迁（报告用） */
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
