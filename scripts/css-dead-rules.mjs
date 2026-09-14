/**
 * 死规则清理（P0-1 样式收敛的最后一步）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它在找什么
 * ══════════════════════════════════════════════════════════════════
 * 层层覆盖的另一个后果：早期文件里的规则**每一条属性都被后面盖掉**，
 * 于是它对最终效果毫无贡献 —— 但还在文件里，读代码的人得逐条核对才知道。
 * 这类规则迁移工具不敢动（它们是「被覆盖的选择器」，平移会改变层叠），
 * 但**删除**是安全的：删掉之后最终计算值不变。
 *
 * ── 判定规则 ──
 * 对同一 (媒体查询, 选择器) 的多条规则，从最后一条往前扫，维护「后面已经
 * 声明过的属性集合」。若某条规则的所有属性都在该集合里，它就是死规则。
 *
 * ⚠️ `!important` 要特殊对待：如果早期规则带 `!important` 而后面那条不带，
 *    赢的是**早期**那条 —— 这时不能判死。只有「后面的也带 !important」
 *    或「两边都不带」才算被覆盖。
 *
 * 用法：
 *   node scripts/css-dead-rules.mjs --file stage1.css [--file redesign.css] [--dry]
 *
 * 改完必须跑：
 *   node scripts/css-layer-check.mjs <改动前的 styles 快照> src/renderer/src/styles
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/src/styles')

/** 与 App.tsx 的 import 顺序一致 —— 覆盖关系全看它 */
const ORDER = [
  'tokens.css',
  'app.css',
  'stage1.css',
  'redesign.css',
  'motion.css',
  'settings.css',
  'electron.css',
  'highlight.css',
  'layout.css',
  'shell.css',
  'rail.css',
  'chat.css',
  'composer.css',
  'tools.css',
  'browser.css',
  'dialog.css'
]

/** 扫描顶层规则，记录精确区间（用于原地删除） */
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

/** 解析声明：[{prop, important}] */
function declsOf(bodyRaw) {
  /*
   * ⚠️ 先抹掉注释：否则属性之间夹着一段 CSS 注释时，注释会被并进属性名，
   *    覆盖判定静默失效（css-merge-dups.mjs 里因为这个报出 8 处层叠不一致）。
   */
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
/*
 * ⚠️ 必须去重：同一个文件传两次会让它被删两遍 —— 第二遍用的是**旧的**
 *    字符位置，会删错地方。实测踩过一次（报 6 处层叠不一致，但工具本身没错）。
 */
const targets = [
  ...new Set(argv.reduce((acc, a, i) => (a === '--file' ? [...acc, argv[i + 1]] : acc), []))
]

if (targets.length === 0) {
  console.error('用法: node scripts/css-dead-rules.mjs --file stage1.css [--file redesign.css] [--dry]')
  process.exit(2)
}

/* 1. 按加载顺序收集所有文件的规则（同时缓存文件内容，省得反复读盘） */
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

/** 取规则的原始声明文本 */
const readBody = (block) => fileSrc.get(block.file).slice(block.bodyStart, block.bodyEnd)

/* 2. 按 (media, selector) 分组，保持加载顺序 */
const groups = new Map()
for (const b of all) {
  const key = `${b.media}|${b.head}`
  const arr = groups.get(key) ?? []
  arr.push(b)
  groups.set(key, arr)
}

/* 3. 从后往前标记死规则 */
const toDelete = [] // {file, headStart, end, head}
let partial = 0
for (const [, rules] of groups) {
  const seen = new Map() // prop → important（后面最近一次声明的强度）
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]
    const decls = declsOf(readBody(r))
    const covered = decls.length > 0 && decls.every((d) => {
      if (!seen.has(d.prop)) return false
      const laterImportant = seen.get(d.prop)
      /* 我带 !important 而后面不带 → 我赢，不算被覆盖 */
      if (d.important && !laterImportant) return false
      return true
    })
    if (covered) {
      toDelete.push({ file: r.file, headStart: r.headStart, end: r.end, head: r.head })
    } else if (decls.some((d) => seen.has(d.prop))) {
      partial++ // 部分属性冗余（不改，只报告）
    }
    for (const d of decls) seen.set(d.prop, d.important)
  }
}

/* 读原始 body 的工具（定义见上，这里仅保留注释占位以避免重复定义） */

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

/* 4. 按文件删（倒序，避免位置偏移） */
for (const f of targets) {
  const arr = (byFile.get(f) ?? []).sort((a, b) => b.headStart - a.headStart)
  if (arr.length === 0) continue
  let src = readFileSync(join(dir, f), 'utf8')
  for (const r of arr) src = src.slice(0, r.headStart) + src.slice(r.end)
  src = src.replace(/\n{3,}/g, '\n\n')
  writeFileSync(join(dir, f), src, 'utf8')
}

console.log(`\n✓ 已删除 ${targets.reduce((n, f) => n + (byFile.get(f)?.length ?? 0), 0)} 条死规则`)
