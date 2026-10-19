import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'

const LEGACY_ORDER = [
  'tokens.css',
  'ui.css',
  'app.css',
  'stage1.css',
  'redesign.css',
  'motion.css',
  'settings.css',
  'electron.css',
  'highlight.css',
  'layout.css',
  'shell.css',
  'dialog.css',
  'rail.css',
  'chat.css',
  'composer.css',
  'tools.css',
  'browser.css',
  'terminal.css',
  'workbench.css',
  'icon-state.css'
]

function entriesOf(dir) {
  const index = join(dir, 'index.css')
  if (!existsSync(index)) {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.css')) : []
    const extra = files.filter((f) => !LEGACY_ORDER.includes(f)).sort()
    return [...LEGACY_ORDER, ...extra].map((name) => ({
      name,
      layerIndex: Infinity
    }))
  }
  const src = readFileSync(index, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const layers = (/@layer\s+([\w\s,-]+);/.exec(src)?.[1] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const out = []
  for (const m of src.matchAll(/@import\s+'\.\/([\w.-]+\.css)'(?:\s+layer\(([\w-]+)\))?\s*;/g)) {
    out.push({
      name: m[1],
      layerIndex: m[2] ? layers.indexOf(m[2]) : Infinity
    })
  }
  return out
}

function splitTopLevel(s, sep) {
  const parts = []
  let depth = 0
  let quote = ''
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      buf += ch
      if (ch === quote && s[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  parts.push(buf)
  return parts
}

function parseDecl(decl) {
  const norm = decl.replace(/\s+/g, ' ').trim()
  if (!norm) return null
  const idx = norm.indexOf(':')
  if (idx < 0) return null
  const prop = norm.slice(0, idx).trim()
  if (!prop) return null
  let value = norm.slice(idx + 1).trim()
  let important = false
  const m = /!\s*important\s*$/i.exec(value)
  if (m) {
    important = true
    value = value.slice(0, m.index).trim()
  }
  return { prop, value, important }
}

const fmt = (d) => `${d.value}${d.important ? ' !important' : ''}`

const SIDES = ['top', 'right', 'bottom', 'left']
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
const SHORTHANDS = {
  padding: SIDES.map((x) => `padding-${x}`),
  margin: SIDES.map((x) => `margin-${x}`),
  inset: SIDES,
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  'border-radius': CORNERS.map((x) => `border-${x}-radius`),
  'border-width': SIDES.map((x) => `border-${x}-width`),
  'border-style': SIDES.map((x) => `border-${x}-style`),
  'border-color': SIDES.map((x) => `border-${x}-color`),
  border: SIDES.flatMap((x) => [`border-${x}-width`, `border-${x}-style`, `border-${x}-color`]),
  ...Object.fromEntries(
    SIDES.map((x) => [`border-${x}`, [`border-${x}-width`, `border-${x}-style`, `border-${x}-color`]])
  ),
  outline: ['outline-width', 'outline-style', 'outline-color'],
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  font: ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-fill-mode'
  ],
  'grid-template': ['grid-template-rows', 'grid-template-columns'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content']
}

function expand(d) {
  const longs = SHORTHANDS[d.prop]
  if (!longs) return [d]
  return longs.map((prop) => ({ ...d, prop, value: `${d.prop}(${d.value})` }))
}

function layer(dir) {
  const result = new Map()
  for (const { name, layerIndex } of entriesOf(dir)) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    const css = readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    let i = 0
    let depth = 0
    let media = ''
    const apply = (head, body) => {
      if (!head || head.startsWith('@')) return
      for (const one of splitTopLevel(head, ',')) {
        const sel = one.replace(/\s+/g, ' ').trim()
        if (!sel) continue
        const key = (media ? media + ' ' : '') + sel
        const m = result.get(key) ?? new Map()
        for (const raw of splitTopLevel(body, ';')) {
          const parsed = parseDecl(raw)
          if (!parsed) continue
          for (const d of expand(parsed)) {
            d.layerIndex = layerIndex
            const prev = m.get(d.prop)
            let wins
            if (!prev) wins = true
            else if (prev.important !== d.important) wins = d.important
            else if (d.important) wins = d.layerIndex <= prev.layerIndex
            else wins = d.layerIndex >= prev.layerIndex
            if (wins) m.set(d.prop, d)
          }
        }
        result.set(key, m)
      }
    }
    let headStart = 0
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
        let d = 1
        let j = i + 1
        let body = ''
        while (j < css.length && d > 0) {
          if (css[j] === '{') d++
          else if (css[j] === '}') {
            d--
            if (d === 0) break
          }
          body += css[j]
          j++
        }
        if (depth === 0 || media) apply(head, body)
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
      if (ch === ';' && depth === 0) headStart = i + 1
      i++
    }
  }
  return result
}

function resolver(map) {
  const root = map.get(':root') ?? new Map()
  const resolve = (value, depth = 0) =>
    depth > 8
      ? value
      : value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (m, name) => {
          const d = root.get(name)
          return d ? resolve(d.value, depth + 1) : m
        })
  return resolve
}

function compare(A, B) {
  const issues = []
  const ra = resolver(A)
  const rb = resolver(B)
  for (const [key, props] of A) {
    const now = B.get(key)
    if (!now) {
      issues.push(`✗ 选择器消失：${key}`)
      continue
    }
    for (const [prop, a] of props) {
      const b = now.get(prop)
      if (!b) issues.push(`✗ 属性消失：${key} { ${prop}: ${fmt(a)} }`)
      else if (rb(b.value) !== ra(a.value) || b.important !== a.important) {
        issues.push(`✗ 值变化：${key} { ${prop}: ${fmt(a)} → ${fmt(b)} }`)
      }
    }
  }
  for (const [key, props] of B) {
    const was = A.get(key)
    for (const [prop, value] of props) {
      if (!was || !was.has(prop)) issues.push(`✗ 新增属性：${key} { ${prop}: ${fmt(value)} }`)
    }
  }
  return issues
}

function selftest() {
  const cases = [
    {
      name: '逐选择器：`.a, .b` 拆开后与单独写等价',
      a: { 'zz-a.css': '.a, .b { color: red }\n.b { color: blue }\n' },
      b: { 'zz-a.css': '.a { color: red }\n.b { color: blue }\n' },
      expect: 0
    },
    {
      name: 'important 赢过非 important（后期不带 important 不该覆盖它）',
      a: {
        'zz-a.css': '.x { padding: 1px !important }\n.x { padding: 2px }\n'
      },
      b: { 'zz-a.css': '.x { padding: 1px !important }\n' },
      expect: 0
    },
    {
      name: '假通过用例：同值时 important 被覆盖掉（旧版会判等价）',
      a: {
        'zz-a.css': '.x { padding: 1px !important }\n.x { padding: 1px }\n.x { padding: 2px }\n'
      },
      b: { 'zz-a.css': '.x { padding: 1px }\n.x { padding: 2px }\n' },
      expect: 1
    },
    {
      name: 'important ↔ 非 important 的值变化要报出来',
      a: { 'zz-a.css': '.x { padding: 1px !important }\n' },
      b: { 'zz-a.css': '.x { padding: 1px }\n' },
      expect: 1
    },
    {
      name: '同档 important 后写赢（顺序有意义）',
      a: {
        'zz-a.css': '.x { padding: 1px !important }\n.x { padding: 2px !important }\n'
      },
      b: { 'zz-a.css': '.x { padding: 2px !important }\n' },
      expect: 0
    },
    {
      name: ':is(.a, .b) 里的逗号不算顶层分隔（不能被拆坏）',
      run: () =>
        splitTopLevel(':is(.a, .b), [data-x="p,q"]', ',').length === 2 && splitTopLevel('.a, .b', ',').length === 2
    },
    {
      name: '声明里的分号在括号内不拆分（url(data:…;base64,…)）',
      run: () => splitTopLevel('background: url(data:image/svg+xml;base64,AAA); color: red', ';').length === 2
    },
    {
      name: '跨 @media 不判胜负：挪到媒体查询外必须报错',
      a: { 'zz-a.css': '@media (max-width: 900px) { .y { color: red } }\n' },
      b: { 'zz-a.css': '.y { color: red }\n' },
      expect: 1
    },
    {
      name: '注释必须先抹掉（否则属性名会被污染）',
      a: { 'zz-a.css': '.x { /* padding */ color: red }\n' },
      b: { 'zz-a.css': '.x { color: red }\n' },
      expect: 0
    },
    {
      name: '简写覆盖长写：后出现的 padding 盖掉先前的 padding-top 要报出来',
      a: { 'zz-a.css': '.x { padding: 12px }\n.x { padding-top: 0 }\n' },
      b: { 'zz-a.css': '.x { padding-top: 0 }\n.x { padding: 12px }\n' },
      expect: 1
    },
    {
      name: '多文件顺序：后者覆盖前者',
      a: {
        'zz-a.css': '.x { color: red }\n',
        'zz-b.css': '.x { color: blue }\n'
      },
      b: { 'zz-a.css': '.x { color: blue }\n' },
      expect: 0
    }
  ]

  let failed = 0
  for (const c of cases) {
    if (c.run) {
      const pass = c.run() === true
      if (!pass) failed++
      console.log(`${pass ? '  ✓' : '  ✗'} ${c.name}`)
      continue
    }
    const dirs = []
    const write = (spec) => {
      const d = mkdtempSync(join(tmpdir(), 'layerselftest-'))
      dirs.push(d)
      for (const [name, css] of Object.entries(spec)) writeFileSync(join(d, name), css)
      return d
    }
    try {
      const issues = compare(layer(write(c.a)), layer(write(c.b)))
      const got = issues.length === 0 ? 0 : 1
      const pass = got === c.expect
      if (!pass) failed++
      console.log(`${pass ? '  ✓' : '  ✗'} ${c.name}`)
      if (!pass)
        console.log(`      期望 ${c.expect === 0 ? '等价' : '报错'}，实际 ${got === 0 ? '等价' : issues.join(' / ')}`)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  }
  console.log('')
  console.log(failed === 0 ? `✓ 自检通过（${cases.length} 个用例）` : `✗ 自检失败 ${failed}/${cases.length}`)
  process.exit(failed ? 1 : 0)
}

const argv = process.argv.slice(2)
if (argv.includes('--selftest')) {
  selftest()
} else {
  const [beforeDir, afterDir = 'src/renderer/src/styles'] = argv
  if (!beforeDir) {
    console.error('用法: node scripts/css-layer-check.mjs <迁移前的 styles 目录> [迁移后目录]')
    console.error('      node scripts/css-layer-check.mjs --selftest')
    process.exit(2)
  }

  const A = layer(resolve(beforeDir))
  const B = layer(resolve(afterDir))
  const issues = compare(A, B)
  for (const s of issues) console.log(s)

  console.log('')
  console.log(`  ${basename(resolve(beforeDir))}：${A.size} 个 (媒体查询,选择器) 组合`)
  console.log(`  ${basename(resolve(afterDir))}：${B.size} 个`)
  if (issues.length === 0) console.log(`\n✓ 层叠等价：计算后的声明完全一致`)
  else {
    console.log(`\n✗ 有 ${issues.length} 处不一致`)
    process.exit(1)
  }
}
