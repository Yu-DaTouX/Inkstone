import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readStyleOrder } from './lib/css-order.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      blocks.push({ sel: head.replace(/\s+/g, ' '), body: css.slice(i + 1, j), media })
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

const bySel = new Map()
for (const f of ORDER) {
  let css
  try {
    css = readFileSync(join(dir, f), 'utf8')
  } catch {
    continue
  }
  for (const b of scan(css)) {
    if (!/^(:root|html|\[data-theme)/.test(b.sel)) continue
    const key = b.media ? `${b.media} ${b.sel}` : b.sel
    const vars = bySel.get(key) ?? new Map()
    for (const decl of b.body.split(';')) {
      const d = decl.trim()
      if (!d) continue
      const i = d.indexOf(':')
      if (i < 0) continue
      const k = d.slice(0, i).trim()
      if (!k.startsWith('--')) continue
      const arr = vars.get(k) ?? []
      arr.push({ file: f, value: d.slice(i + 1).trim() })
      vars.set(k, arr)
    }
    bySel.set(key, vars)
  }
}

const selOrder = [...bySel.keys()]
  .filter((s) => {
    return (bySel.get(s)?.size ?? 0) > 0
  })
  .sort((a, b) => {
    const rank = (s) => (s === ':root' ? 0 : /dark/.test(s) ? 1 : /light/.test(s) ? 2 : 3)
    return rank(a) - rank(b) || a.localeCompare(b)
  })

let totalVars = 0
let redundant = 0
const md = []
const L = (s = '') => md.push(s)

L('# 设计令牌清单（自动生成）')
L()
L('> 由 `node scripts/css-tokens.mjs --md` 生成。改令牌后重新生成。')
L('>')
L('> **只有每个变量的“最终值”生效** —— 它可能不在 `tokens.css` 里。')
L('> 定义链从左到右，最右者胜（同特异性、后加载）。')
L()

for (const sel of selOrder) {
  const vars = bySel.get(sel)
  const list = [...vars.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (list.length === 0) continue
  const dup = list.filter(([, a]) => a.length > 1)
  totalVars += list.length
  redundant += dup.length
  L(`## \`${sel}\`　${list.length} 个变量${dup.length ? `（其中 ${dup.length} 个被重复定义）` : ''}`)
  L()
  L('| 变量 | 最终值 | 定义链 |')
  L('| --- | --- | --- |')
  for (const [k, arr] of list) {
    const last = arr[arr.length - 1]
    const chain = arr
      .map((x, i) => (i === arr.length - 1 ? `**${x.file.replace('.css', '')}**: ${x.value}` : `${x.file.replace('.css', '')}: ${x.value}`))
      .join(' → ')
    const flag = arr.length > 1 ? ' ⚠️' : ''
    L(`| \`${k}\`${flag} | \`${last.value}\` | ${chain} |`)
  }
  L()
}

L('## 小结')
L()
L(`- 变量总数（含各主题）：**${totalVars}**`)
L(`- 同一选择器内被重复定义（真冗余）：**${redundant}**`)
L('- ⚠️ 标记的那些：改值要改**最后一个**，否则看不到效果；')
L('  它们是「令牌归并」的候选（把最终值收敛到 tokens.css 并删掉中间覆盖）。')
L()

const out = md.join('\n')
const content = out.replace(/\n+$/, '') + '\n'
if (process.argv.includes('--check')) {
  const target = join(root, 'scripts/design/CSS-令牌清单.md')
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (existing !== content) {
    console.error(`✗ ${target} 与当前样式不一致 —— 跑 npm run measure:css 重新生成`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${target} 与当前样式一致`)
  }
} else if (process.argv.includes('--md')) {
  const target = join(root, 'scripts/design/CSS-令牌清单.md')
  writeFileSync(target, content, 'utf8')
  console.log(`已写入 ${target}`)
  console.log(`  选择器分组 ${selOrder.length} 个 / 变量 ${totalVars} 个 / 其中重复定义 ${redundant} 个`)
} else {
  console.log(out)
}
