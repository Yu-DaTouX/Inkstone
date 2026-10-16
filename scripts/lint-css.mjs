import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = [
  join(root, 'src/renderer/src/styles'),
  join(root, 'scripts/design/prototype.html')
]

async function collect(target) {
  if (target.endsWith('.html') || target.endsWith('.css')) return [target]
  const out = []
  for (const e of await readdir(target, { withFileTypes: true })) {
    const p = join(target, e.name)
    if (e.isDirectory()) out.push(...(await collect(p)))
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

function findBareFr(css) {
  const hits = []
  const lines = css.split('\n')

  lines.forEach((line, i) => {
    const m = /grid-template-columns\s*:\s*([^;}]+)/.exec(line)
    if (!m) return

    const value = m[1]
    const stripped = stripCalls(value, 'minmax')
    if (/\d+(\.\d+)?fr/.test(stripped)) {
      hits.push({ line: i + 1, text: line.trim(), value: value.trim() })
    }
  })

  return hits
}

function stripCalls(value, name) {
  const head = new RegExp(`^${name}\\s*\\(`, 'i')
  let out = ''
  let i = 0
  while (i < value.length) {
    const m = head.exec(value.slice(i))
    if (!m) {
      out += value[i]
      i++
      continue
    }
    let depth = 1
    let j = i + m[0].length
    while (j < value.length && depth > 0) {
      if (value[j] === '(') depth++
      else if (value[j] === ')') depth--
      j++
    }
    out += ' '
    i = j
  }
  return out
}

console.log('=== CSS 守卫：grid 的 1fr 必须用 minmax(0, 1fr) ===\n')

const files = (await Promise.all(TARGETS.map(collect))).flat()
let badFr = 0
let badBrace = 0

function braceImbalance(css) {
  let depth = 0
  let firstBad = 0
  const lines = css.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth < 0 && !firstBad) firstBad = i + 1
      }
    }
  }
  return depth === 0 ? null : { depth, firstBad: firstBad || lines.length }
}

for (const file of files) {
  const css = await readFile(file, 'utf8')
  const rel = relative(root, file).replace(/\\/g, '/')
  const imbalance = braceImbalance(css)
  if (imbalance) {
    badBrace++
    console.log(`✗ ${rel}  花括号不平衡（结束时还差 ${imbalance.depth} 个 }）—— 后面全部规则会失效`)
    continue
  }
  const hits = findBareFr(css)

  if (hits.length === 0) {
    console.log(`✓ ${rel}`)
    continue
  }

  badFr += hits.length
  console.log(`✗ ${rel}`)
  for (const h of hits) {
    console.log(`    ${h.line} 行: ${h.value}`)
  }
}

console.log()
if (badBrace) {
  console.log(`✗ 有 ${badBrace} 个文件的花括号不平衡 —— 那里之后的所有规则都会**静默失效**`)
}
if (badFr) {
  console.log(`✗ 发现 ${badFr} 处裸 1fr —— 换成 minmax(0, 1fr)（原因见 DESIGN.md §8）`)
}
if (badBrace || badFr) process.exit(1)
console.log(`✓ 全部合规（检查了 ${files.length} 个文件）`)
