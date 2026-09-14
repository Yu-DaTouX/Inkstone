/**
 * 校验「样式拆分是等价重构」。
 *
 * P0-1 迁移的铁律是**只搬家、不改值**：把一个补丁文件按模块拆到多个文件后，
 * 每个选择器算出的声明必须一字不差，否则就是偷偷改了视觉。
 * 靠肉眼比对 8000 行 CSS 是不现实的（实测已经漏过一次：把
 * `.rp-dim`/`.rp-quota-plan` 从一条 min-width 规则里拆出来，还顺手加了 color）。
 *
 * 用法：
 *   node scripts/css-split-check.mjs <原文件> <拆出的文件...>
 * 例：
 *   node scripts/css-split-check.mjs \
 *     src/renderer/src/styles/sidebar-review.css \
 *     src/renderer/src/styles/layout.css src/renderer/src/styles/rail.css ...
 *
 * 退出码非 0 表示存在差异。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 把 CSS 解析成 Map<selector, Map<property, value>>。
 *
 * 按**属性**存而不是按「声明串」存：CSS 层叠里同属性后者覆盖前者，
 * 所以 `letter-spacing: normal` 后面又写 `letter-spacing: -0.01em`，
 * 实际生效的只是后者 —— 归一成最终值才能正确判断「等价」。
 * 保留前者反而会把「重复声明」这个噪声固化下来，那是 P0-1 要清的东西。
 */
function parse(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const map = new Map()
  let buf = ''
  let depth = 0
  let media = ''
  let i = 0
  const add = (sel, body) => {
    const key = media ? `${media} ${sel}` : sel
    const m = map.get(key) ?? new Map()
    for (const d of body.split(';')) {
      const norm = d.replace(/\s+/g, ' ').trim()
      if (!norm) continue
      const idx = norm.indexOf(':')
      if (idx < 0) continue
      const prop = norm.slice(0, idx).trim()
      const value = norm.slice(idx + 1).trim()
      if (prop && value) m.set(prop, value)
    }
    map.set(key, m)
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const head = buf.trim()
      depth++
      if (head.startsWith('@media') || head.startsWith('@supports')) {
        media = head.replace(/\s+/g, ' ')
        buf = ''
        i++
        continue
      }
      if (head.startsWith('@')) {
        /* @keyframes 之类：整块跳过（我们关心的是普通规则） */
        let d = 1
        i++
        while (i < text.length && d > 0) {
          if (text[i] === '{') d++
          else if (text[i] === '}') d--
          i++
        }
        depth--
        buf = ''
        continue
      }
      /* 找配对的 } */
      let d = 1
      let j = i + 1
      let body = ''
      while (j < text.length && d > 0) {
        if (text[j] === '{') d++
        else if (text[j] === '}') {
          d--
          if (d === 0) break
        }
        body += text[j]
        j++
      }
      for (const one of head.split(',')) {
        const s = one.replace(/\s+/g, ' ').trim()
        if (s) add(s, body)
      }
      i = j + 1
      depth--
      media = ''
      buf = ''
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      media = ''
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  return map
}

const [origPath, ...restPaths] = process.argv.slice(2)
if (!origPath || restPaths.length === 0) {
  console.error('用法: node scripts/css-split-check.mjs <原文件> <拆出的文件...>')
  process.exit(2)
}

const orig = parse(readFileSync(join(root, origPath), 'utf8'))
const merged = new Map()
for (const p of restPaths) {
  for (const [k, v] of parse(readFileSync(join(root, p), 'utf8'))) {
    const m = merged.get(k) ?? new Map()
    for (const [prop, value] of v) m.set(prop, value)
    merged.set(k, m)
  }
}

let bad = 0

/* ① 原来有的选择器 / 属性，最终值必须一致 */
for (const [sel, props] of orig) {
  const now = merged.get(sel)
  if (!now) {
    console.log(`✗ 丢失选择器：${sel}`)
    bad++
    continue
  }
  for (const [prop, value] of props) {
    if (!now.has(prop)) {
      console.log(`✗ 丢失属性：${sel} { ${prop}: ${value} }`)
      bad++
    } else if (now.get(prop) !== value) {
      console.log(`✗ 值改变：${sel} { ${prop}: ${value} → ${now.get(prop)} }`)
      bad++
    }
  }
}

/* ② 不能凭空多出属性（多出 = 偷偷改了样式） */
for (const [sel, props] of merged) {
  const was = orig.get(sel)
  for (const [prop, value] of props) {
    if (!was || !was.has(prop)) {
      console.log(`✗ 多出属性：${sel} { ${prop}: ${value} }`)
      bad++
    }
  }
}

console.log('')
if (bad === 0) {
  console.log(`✓ 等价：${orig.size} 个选择器的最终声明完全一致（${restPaths.length} 个文件）`)
} else {
  console.log(`✗ 不一致：${bad} 处`)
  process.exit(1)
}
