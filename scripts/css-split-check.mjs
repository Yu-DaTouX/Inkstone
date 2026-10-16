import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
