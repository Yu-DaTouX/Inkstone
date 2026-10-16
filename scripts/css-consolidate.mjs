import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/src/styles')

const mask = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

function scan(cssRaw) {
  const css = mask(cssRaw)
  const blocks = []
  let depth = 0
  let headStart = 0
  let media = ''
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      const rawHead = cssRaw.slice(headStart, i)
      const head = mask(rawHead).trim()
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
        media,
        depth
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

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const files = argv.filter((a) => !a.startsWith('--'))

if (files.length === 0) {
  console.error('用法: node scripts/css-consolidate.mjs <文件...> [--dry]')
  process.exit(2)
}

let totalMerged = 0
let totalRemoved = 0

for (const name of files) {
  const path = join(dir, name)
  const src = readFileSync(path, 'utf8')
  const blocks = scan(src)

  const groups = new Map()
  let multiSel = 0
  for (const b of blocks) {
    if (b.head.split(',').length !== 1) {
      multiSel++
      continue
    }
    const key = `${b.media}|${b.head}`
    const arr = groups.get(key) ?? []
    arr.push(b)
    groups.set(key, arr)
  }

  const events = []
  const merged = []
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue
    const decls = arr
      .map((b) => src.slice(b.bodyStart, b.bodyEnd).replace(/^\s*\n|\n\s*$/g, ''))
      .filter((d) => d.trim())
      .join('\n')
    const last = arr[arr.length - 1]
    const selText = src.slice(last.headStart, last.headEnd).trim()
    events.push({ start: last.headStart, end: last.end, text: `${selText} {\n${decls}\n}` })
    for (const b of arr.slice(0, -1)) events.push({ start: b.headStart, end: b.end, text: '' })
    merged.push({ sel: last.head, media: last.media, n: arr.length })
  }

  if (events.length === 0) {
    console.log(`${name}: 无需归并（${blocks.length} 条规则）`)
    continue
  }

  events.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const e of events) {
    out += src.slice(cursor, e.start) + e.text
    cursor = e.end
  }
  out += src.slice(cursor)
  out = out.replace(/\n{3,}/g, '\n\n')

  console.log(`${name}: 归并 ${merged.length} 个选择器（合并掉 ${merged.reduce((n, m) => n + m.n - 1, 0)} 条重复规则）`)
  for (const m of merged.slice(0, 12)) console.log(`    · ${m.media ? '[' + m.media + '] ' : ''}${m.sel} ×${m.n}`)
  if (merged.length > 12) console.log(`    · …另有 ${merged.length - 12} 个`)
  if (multiSel) console.log(`    （跳过 ${multiSel} 条多选择器规则）`)

  totalMerged += merged.length
  totalRemoved += merged.reduce((n, m) => n + m.n - 1, 0)

  if (!dry) writeFileSync(path, out, 'utf8')
}

console.log('')
console.log(dry ? `--dry：将归并 ${totalMerged} 个选择器、去掉 ${totalRemoved} 条重复` : `✓ 归并 ${totalMerged} 个选择器，去掉 ${totalRemoved} 条重复规则`)
