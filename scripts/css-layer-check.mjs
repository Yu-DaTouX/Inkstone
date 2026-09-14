/**
 * 层叠等价校验：迁移 CSS 规则后，最终生效的声明必须一字不变。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能只做文本 diff
 * ══════════════════════════════════════════════════════════════════
 * 迁移的意义就是「同一批声明换个文件放」。文本必然不同，但**计算后的结果**
 * 必须相同：对每个 (媒体查询, 选择器)，把所有文件按加载顺序叠一遍，
 * 属性取最后一次生效的赋值 —— 这个结果前后要完全一致。
 *
 * ══════════════════════════════════════════════════════════════════
 * 逐选择器
 * ══════════════════════════════════════════════════════════════════
 * `.a, .b { … }` 会拆成 `.a{}` 与 `.b{}` 两条独立记录再比。否则一条多选择器
 * 规则在比对里是「一个整体」，它与单独出现的 `.b{}` 之间的覆盖关系就看不见了。
 * 拆分是按**括号/引号深度**做的 —— 直接 `split(',')` 会把
 * `:is(.a, .b)` 或 `[data-x="a,b"]` 拆坏。
 *
 * ══════════════════════════════════════════════════════════════════
 * `!important`（这是本工具曾经会「说谎」的地方）
 * ══════════════════════════════════════════════════════════════════
 * 旧版把 `!important` 当成**值的一部分**（`"1px !important"`）直接比较。后果：
 *
 *   · 误报：早期带 important、后期不带，值字符串不同 → 报「值变化」，
 *     而实际早期那条赢、结果没变 —— 于是本该允许的迁移被拦下；
 *   · **假通过**（更危险）：同值时 important 被后写覆盖掉，
 *     `{p:1px!important}{p:1px}{p:2px}` 与 `{p:1px}{p:2px}` 被判成等价，
 *     但前者实际是 `1px`、后者是 `2px`。
 *
 * 现在 important 是独立维度，覆盖规则按 CSS 规范：带 important 的声明赢过
 * 不带的；两者同为 important（或同为普通）时后写覆盖前写。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界（刻意的保守）
 * ══════════════════════════════════════════════════════════════════
 *   · **跨 @media 不判胜负**：`@media` 内外的同类声明谁生效取决于视口，
 *     静态判不了。所以媒体查询进 key，等于「各比各的」。宁可漏合并。
 *   · **不建模选择器之间的特异性**：`.a` 与 `.c.a` 谁赢不在这里算。本工具
 *     只保证「同一选择器自己的声明集不变」，够用来验证「换文件放」，
 *     不足以单独证明「改变规则之间的相对顺序」是等价的。
 *     所以合并规则时，除了本工具，还要保证**同属性同选择器的相对顺序**不变。
 *
 * 用法：
 *   node scripts/css-layer-check.mjs <迁移前的 styles 目录> [迁移后目录]
 *   node scripts/css-layer-check.mjs --selftest         # 自检（含上面的假通过用例）
 *
 * 典型流程（迁移前先拍快照）：
 *   cp -r src/renderer/src/styles /tmp/styles-before
 *   node scripts/css-migrate.mjs --from redesign.css --to tools.css --match ".rp-"
 *   node scripts/css-layer-check.mjs /tmp/styles-before src/renderer/src/styles
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'

/* 加载顺序无关紧要（两个目录用同一套规则），但必须**两个目录一致** */
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

/** 按顶层逗号拆选择器（尊重括号与引号） */
function splitTopLevel(s, sep) {
  const parts = []
  let depth = 0
  let quote = ''
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      buf += ch
      /* 反斜杠转义：`"a\"b"` 里的引号不算结束 */
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

/**
 * 一条声明 → `{ prop, value, important }`。
 *
 * `!important` 前可有空格、大小写任意（`!IMPORTANT` 也合法）。
 */
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

/** 解析成 Map<"媒体查询|选择器", Map<属性, {value, important}>>，同 key 按层叠规则合并 */
function layer(dir) {
  const result = new Map()
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.css')) : []
  /* 目录里可能有 ORDER 之外的新文件（比如设置页的独立样式），一并纳入，
     但放在 ORDER 之后 —— 以文件名为序，保证两个目录的处理顺序一致 */
  const extra = files.filter((f) => !ORDER.includes(f)).sort()
  for (const name of [...ORDER, ...extra]) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    const css = readFileSync(p, 'utf8')
      /*
       * ⚠️ 必须先抹掉注释：否则注释尾巴会与后面的属性名粘成
       *    「… padding」这样一个假属性名，覆盖判定**静默失效**
       *    （实测造成过 8 处层叠不一致）。
       */
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
          const d = parseDecl(raw)
          if (!d) continue
          const prev = m.get(d.prop)
          /*
           * 层叠：important 赢过非 important；同档后写赢。
           * prev 是 important 而新声明不是 → 保留 prev（这正是旧版丢掉的那一步）。
           */
          if (!prev || !prev.important || d.important) m.set(d.prop, d)
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
        /* 找配对 */
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

/**
 * 比较两份层叠结果，返回问题列表（空 = 等价）。
 *
 * 抽成函数是为了 `--selftest` 能直接调用，不用起子进程。
 */
function compare(A, B) {
  const issues = []
  for (const [key, props] of A) {
    const now = B.get(key)
    if (!now) {
      issues.push(`✗ 选择器消失：${key}`)
      continue
    }
    for (const [prop, a] of props) {
      const b = now.get(prop)
      if (!b) issues.push(`✗ 属性消失：${key} { ${prop}: ${fmt(a)} }`)
      else if (b.value !== a.value || b.important !== a.important) {
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

/* ------------------------------------------------------------ 自检 */

/**
 * 内置用例。校验器本身错了，会连带把「不等价」判成等价 —— 这是最难发现的一类
 * 错误（工具的假通过）。所以把关键语义固化成用例，改完跑一次。
 */
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
      a: { 'zz-a.css': '.x { padding: 1px !important }\n.x { padding: 2px }\n' },
      b: { 'zz-a.css': '.x { padding: 1px !important }\n' },
      expect: 0
    },
    {
      name: '假通过用例：同值时 important 被覆盖掉（旧版会判等价）',
      a: { 'zz-a.css': '.x { padding: 1px !important }\n.x { padding: 1px }\n.x { padding: 2px }\n' },
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
      a: { 'zz-a.css': '.x { padding: 1px !important }\n.x { padding: 2px !important }\n' },
      b: { 'zz-a.css': '.x { padding: 2px !important }\n' },
      expect: 0
    },
    {
      name: ':is(.a, .b) 里的逗号不算顶层分隔（不能被拆坏）',
      /* 直接测拆分器：两个目录都拆坏的话比对结果一样，测不出来 */
      run: () =>
        splitTopLevel(':is(.a, .b), [data-x="p,q"]', ',').length === 2 &&
        splitTopLevel('.a, .b', ',').length === 2
    },
    {
      name: '声明里的分号在括号内不拆分（url(data:…;base64,…)）',
      run: () =>
        splitTopLevel('background: url(data:image/svg+xml;base64,AAA); color: red', ';').length === 2
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
      name: '多文件顺序：后者覆盖前者',
      a: { 'zz-a.css': '.x { color: red }\n', 'zz-b.css': '.x { color: blue }\n' },
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
      if (!pass) console.log(`      期望 ${c.expect === 0 ? '等价' : '报错'}，实际 ${got === 0 ? '等价' : issues.join(' / ')}`)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  }
  console.log('')
  console.log(failed === 0 ? `✓ 自检通过（${cases.length} 个用例）` : `✗ 自检失败 ${failed}/${cases.length}`)
  process.exit(failed ? 1 : 0)
}

/* ------------------------------------------------------------ CLI */

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
