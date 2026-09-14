/**
 * CSS 归并工具（P0-1 样式收敛用）：把同一文件里**同名选择器**的多条规则
 * 合成一条。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 * redesign.css 是多次评审叠加的产物，同一个选择器常常有两三条定义
 * （新的在前、旧的在后，靠后者覆盖）。后果：
 *   · 想知道「这条规则最终是什么」，得把整个文件翻一遍；
 *   · 想改一个样式，要判断改哪一条才有效；
 *   · 迁移工具不敢动它们（只搬走一条会改变层叠）。
 *
 * ── 为什么是「串接」而不是「取最终值」──
 * 合并时**保留全部声明、保持原有先后顺序**，只是把几条规则的选择器合并。
 * 这样计算后的结果与原来逐字等价（同属性后者仍然后覆盖前者），
 * 而简写/展开属性（`margin` 与 `margin-top`）的相互覆盖也不会被打乱 ——
 * 「取最终值」听起来更干净，但那种省略会真的改变结果。
 *
 * 合并后的规则放在**最后一条的位置**，所以它与其他选择器的相对次序不变。
 *
 * 用法：
 *   node scripts/css-consolidate.mjs <文件...> [--dry]
 *
 * 改完必须跑：
 *   node scripts/css-layer-check.mjs <改动前的 styles 快照> src/renderer/src/styles
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/src/styles')

/** 屏蔽注释但保留长度 —— 见 css-migrate.mjs 里的同类说明 */
const mask = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** 扫描顶层规则（记录 head/body 的精确区间，便于原地改写） */
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
        /* @keyframes 之类：整块跳过（内部不是普通规则） */
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

  const groups = new Map() // "media|selector" → [block...]
  let multiSel = 0
  for (const b of blocks) {
    if (b.head.split(',').length !== 1) {
      multiSel++ // 多选择器规则不碰（拆开会改变层叠归属）
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
