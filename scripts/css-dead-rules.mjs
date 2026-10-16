import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStyleOrder } from './lib/css-order.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/src/styles')

const ORDER = readStyleOrder(root)

function scan(cssRaw) {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const blocks = []
  let depth = 0
  let headStart = 0
  let media = ''
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      const head = css.slice(headStart, i).trim()
      if (head.startsWith('@media') || head.startsWith('@supports')) {
        media = head.replace(/\s+/g, ' ')
        depth++
        i++
        headStart = i
        continue
      }
      if (head.startsWith('@')) {
        let d = 1
        let j = i + 1
        while (j < css.length && d > 0) {
          if (css[j] === '{') d++
          else if (css[j] === '}') d--
          j++
        }
        i = j
        headStart = j
        continue
      }
      let d = 1
      let j = i + 1
      while (j < css.length && d > 0) {
        if (css[j] === '{') d++
        else if (css[j] === '}') {
          d--
          if (d === 0) break
        }
        j++
      }
      blocks.push({
        headStart,
        headEnd: i,
        bodyStart: i + 1,
        bodyEnd: j,
        end: j + 1,
        head: head.replace(/\s+/g, ' '),
        media
      })
      i = j + 1
      headStart = i
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0) media = ''
      i++
      headStart = i
      continue
    }
    if (ch === ';' && depth === 0) {
      headStart = i + 1
      i++
      continue
    }
    i++
  }
  return blocks
}

function declsOf(bodyRaw) {
  const body = bodyRaw.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const out = []
  for (const raw of body.split(';')) {
    const d = raw.replace(/\s+/g, ' ').trim()
    if (!d) continue
    const i = d.indexOf(':')
    if (i < 0) continue
    const prop = d.slice(0, i).trim()
    if (!prop) continue
    out.push({ prop, important: /!important/i.test(d) })
  }
  return out
}

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const targets = [
  ...new Set(argv.reduce((acc, a, i) => (a === '--file' ? [...acc, argv[i + 1]] : acc), []))
]

if (targets.length === 0) {
  console.error('用法: node scripts/css-dead-rules.mjs --file stage1.css [--file redesign.css] [--dry]')
  process.exit(2)
}

const fileSrc = new Map()
const all = []
for (const f of ORDER) {
  let src
  try {
    src = readFileSync(join(dir, f), 'utf8')
  } catch {
    continue
  }
  fileSrc.set(f, src)
  for (const b of scan(src)) all.push({ ...b, file: f })
}

const readBody = (block) => fileSrc.get(block.file).slice(block.bodyStart, block.bodyEnd)

const groups = new Map()
for (const b of all) {
  const key = `${b.media}|${b.head}`
  const arr = groups.get(key) ?? []
  arr.push(b)
  groups.set(key, arr)
}

const toDelete = []
let partial = 0
for (const [, rules] of groups) {
  const seen = new Map()
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]
    const decls = declsOf(readBody(r))
    const covered = decls.length > 0 && decls.every((d) => {
      if (!seen.has(d.prop)) return false
      const laterImportant = seen.get(d.prop)
      if (d.important && !laterImportant) return false
      return true
    })
    if (covered) {
      toDelete.push({ file: r.file, headStart: r.headStart, end: r.end, head: r.head })
    } else if (decls.some((d) => seen.has(d.prop))) {
      partial++
    }
    for (const d of decls) seen.set(d.prop, d.important)
  }
}

const byFile = new Map()
for (const r of toDelete) {
  if (!targets.includes(r.file)) continue
  const arr = byFile.get(r.file) ?? []
  arr.push(r)
  byFile.set(r.file, arr)
}

console.log(`扫描 ${all.length} 条规则 / ${groups.size} 个 (媒体查询,选择器) 组合`)
console.log(`完全被覆盖（可删）：${toDelete.length} 条；部分属性冗余（保持原样）：${partial} 条`)
console.log('')
for (const f of targets) {
  const arr = byFile.get(f) ?? []
  console.log(`${f}: 可删 ${arr.length} 条`)
  for (const r of arr.slice(0, 10)) console.log(`    · ${r.media ? '[' + r.media + '] ' : ''}${r.head}`)
  if (arr.length > 10) console.log(`    · …另有 ${arr.length - 10} 条`)
}

if (dry) {
  console.log('\n--dry：未写文件')
  process.exit(0)
}

for (const f of targets) {
  const arr = (byFile.get(f) ?? []).sort((a, b) => b.headStart - a.headStart)
  if (arr.length === 0) continue
  let src = readFileSync(join(dir, f), 'utf8')
  for (const r of arr) src = src.slice(0, r.headStart) + src.slice(r.end)
  src = src.replace(/\n{3,}/g, '\n\n')
  writeFileSync(join(dir, f), src, 'utf8')
}

console.log(`\n✓ 已删除 ${targets.reduce((n, f) => n + (byFile.get(f)?.length ?? 0), 0)} 条死规则`)
