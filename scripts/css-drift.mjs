/**
 * 设计令牌漂移扫描（实施-13 V-0）。
 *
 * V-0 的出口之一是「列出现有字体/色板/密度真源，以及 token 与散落值的差异」。
 * 手翻 14800 行 CSS 不现实，所以把它做成可重复的扫描：
 *
 *   ① **散落值**：声明里直接写死的颜色 / px / 时长。能反查到同名 token 的
 *      记为「可映射」（迁移候选），反查不到的记为「无对应 token」（语义缺口，
 *      需要设计决策，不是自动替换能解决的）；
 *   ② **未被引用的 token**：定义了但没有任何 `var(--x)` 用到的；
 *   ③ 白名单：`highlight.css` 是语法高亮色板（与 UI 语义无关）、
 *      `@keyframes` 里的百分比、`0`/`1px` 发丝线不算漂移。
 *
 * ⚠️ 这是**分类输入**，不是自动改值清单：把 `#ff6b6b` 换成 `var(--err)`
 * 之前要确认语义真的是「错误色」，不是恰好同色的别的含义。
 *
 * 用法： node scripts/css-drift.mjs [--md]
 *   --md  写入 docs/design/CSS-散落值清单.md
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStyleOrder, stylesDir } from './lib/css-order.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = stylesDir(root)
const ORDER = readStyleOrder(root)

/** 语法高亮色板：它是「代码着色」，不参与 UI 语义令牌 */
const EXEMPT = new Set(['highlight.css'])
/** 与令牌无关的值：零值、发丝线、百分比 */
const IGNORED_LENGTHS = new Set(['0', '0px', '0%', '1px', '50%', '100%', '100vh', '100vw'])

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const norm = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ')

/** `#fff` → `#ffffff`，避免同一个颜色算成两个值 */
function normHex(hex) {
  const h = hex.toLowerCase()
  if (h.length === 4) return '#' + [1, 2, 3].map((i) => h[i] + h[i]).join('')
  if (h.length === 5) return '#' + [1, 2, 3, 4].map((i) => h[i] + h[i]).join('')
  return h
}

/**
 * 颜色与时长的归一化 —— 不归一化就反查不到。
 * `#151515` 与 `rgb(21, 21, 21)` 是同一个颜色，`0.12s` 与 `120ms`
 * 是同一个时长；不折算的话「可映射」会被低估成噪声。
 */
function normColor(value) {
  const s = value.trim().toLowerCase()
  const hex = s.startsWith('#') ? normHex(s) : null
  const parts = hex
    ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    : (() => {
        const m = s.match(/^rgba?\(([^)]*)\)$/)
        if (!m) return null
        return m[1]
          .split(/[,\s/]+/)
          .filter(Boolean)
          .map((p) => (p.endsWith('%') ? Math.round((parseFloat(p) / 100) * 255) : Math.round(parseFloat(p))))
      })()
  if (!parts) return s
  const [r, g, b, a] = parts
  return `rgb(${r ?? 0}, ${g ?? 0}, ${b ?? 0}${a !== undefined ? `, ${Number(a).toFixed(3)}` : ''})`
}

function normTime(value) {
  const m = value.trim().toLowerCase().match(/^(\d*\.?\d+)(m?s)$/)
  if (!m) return norm(value)
  return `ms:${m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1])}`
}

/** 把一个 CSS 值按类型归一化（其它类型原样去空白） */
function normValue(value, kind) {
  if (kind === 'color') return normColor(value)
  if (kind === 'time') return normTime(value)
  return norm(value)
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g
const LENGTH_RE = /(?<![\w.-])\d*\.?\d+px\b/g
const TIME_RE = /(?<![\w.-])\d*\.?\d+m?s\b/g

function collectValue(source, re) {
  const out = []
  for (const m of source.matchAll(re)) out.push(m[0])
  return out
}

/** 读所有样式文件（含注释剥离） */
function readStyles() {
  return ORDER.map((name) => {
    let css = ''
    try {
      css = stripComments(readFileSync(join(dir, name), 'utf8'))
    } catch {
      /* 文件缺失：清单里记 0，不中断 */
    }
    return { name, css }
  })
}

/** token 定义：--name: value（含主题块；同名多值全收集） */
function collectTokens(styles) {
  const tokens = new Map()
  const VAR_DEF = /(--[\w-]+)\s*:\s*([^;{}]+)/g
  for (const { name, css } of styles) {
    for (const m of css.matchAll(VAR_DEF)) {
      const key = m[1]
      const value = norm(m[2])
      if (!tokens.has(key)) tokens.set(key, { values: new Set(), files: new Set() })
      tokens.get(key).values.add(value)
      tokens.get(key).files.add(name)
    }
    // @media 里的定义也在同一次扫描中命中（正则不区分嵌套）
  }
  return tokens
}

/** var(--x) 的引用点：样式 + 组件内联 style；另外包含 JS 里 getPropertyValue('--x') 的读法 */
function collectVarRefs(styles) {
  const refs = new Map()
  const VAR_USE = /var\(\s*(--[\w-]+)/g
  /* 亮点：`--outline-slot-*` 是 JS 读的（量轨道几何）—— 只扫 var() 会把它误报成未使用 */
  const JS_READ = /getPropertyValue\(\s*['"](--[\w-]+)['"]/g
  const add = (name) => refs.set(name, (refs.get(name) ?? 0) + 1)
  for (const { css } of styles) {
    for (const m of css.matchAll(VAR_USE)) add(m[1])
  }
  const srcDir = join(root, 'src/renderer/src')
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(tsx|ts)$/.test(entry.name)) {
        const source = stripComments(readFileSync(full, 'utf8'))
        for (const m of source.matchAll(VAR_USE)) add(m[1])
        for (const m of source.matchAll(JS_READ)) add(m[1])
      }
    }
  }
  walk(srcDir)
  return refs
}

function analyse() {
  const styles = readStyles()
  const tokens = collectTokens(styles)
  const refs = collectVarRefs(styles)

  /* 值 → 令牌名 反查表（令牌自己的值也常是 var()，那种不算“同值可映射”） */
  const valueToTokens = new Map()
  const guessKind = (value) =>
    /^#[0-9a-f]{3,8}$|^rgba?\s*\(|^hsla?\s*\(/.test(value) ? 'color' : /^\d*\.?\d+m?s$/.test(value) ? 'time' : 'length'
  for (const [name, info] of tokens) {
    for (const value of info.values) {
      if (value.startsWith('var(')) continue
      const key = guessKind(value) + '|' + normValue(value, guessKind(value))
      if (!valueToTokens.has(key)) valueToTokens.set(key, new Set())
      valueToTokens.get(key).add(name)
    }
  }

  const perFile = new Map()
  const unmapped = new Map() // 值 → {count, files:Set, kind}
  const DECL = /([-\w]+)\s*:\s*([^;{}]+)(?=[;}])/g

  for (const { name, css } of styles) {
    const stat = { file: name, color: 0, colorHit: 0, length: 0, lengthHit: 0, time: 0, timeHit: 0 }
    perFile.set(name, stat)
    const ingest = (rawValue, kind) => {
      const values =
        kind === 'color'
          ? collectValue(rawValue, COLOR_RE).map(normColor)
          : kind === 'length'
            ? collectValue(rawValue, LENGTH_RE).map(norm).filter((v) => !IGNORED_LENGTHS.has(v))
            : collectValue(rawValue, TIME_RE)
                .map(normTime)
                .filter((v) => !/^ms:0$/.test(v) && !/^ms:1$/.test(v) && !IGNORED_LENGTHS.has(v))
      for (const value of values) {
        stat[kind] += 1
        const hit = valueToTokens.get(kind + '|' + value)
        if (hit) {
          stat[kind + 'Hit'] += 1
          continue
        }
        const key = kind + '|' + value
        if (!unmapped.has(key)) unmapped.set(key, { value, kind, count: 0, files: new Set() })
        const entry = unmapped.get(key)
        entry.count += 1
        entry.files.add(name)
      }
    }
    for (const m of css.matchAll(DECL)) {
      const prop = m[1]
      if (prop.startsWith('--')) continue
      if (EXEMPT.has(name)) continue
      ingest(m[2], 'color')
      ingest(m[2], 'length')
      ingest(m[2], 'time')
    }
  }

  const unused = [...tokens.keys()].filter((name) => !refs.has(name)).sort()
  const duplicate = [...tokens.entries()].filter(([, info]) => info.values.size > 1).map(([name]) => name)

  return { perFile, unmapped, unused, duplicate, tokens, refs }
}

function renderMarkdown(report) {
  const { perFile, unmapped, unused, duplicate, tokens, refs } = report
  const lines = []
  const L = (text = '') => lines.push(text)
  L('# 设计令牌散落值清单（自动生成）')
  L('')
  L('> 由 `node scripts/css-drift.mjs --md` 生成。改令牌或补 token 后重新生成再对比。')
  L('>')
  L('> V-0 的输入之一：`可映射` = 有**同值**的令牌，可考虑替换；`无对应` = 需要设计决策。')
  L('> 语法高亮色板 `highlight.css` 不计（它不是 UI 语义令牌）。')
  L('')
  L('## 1. 各文件散落值')
  L('')
  L('| 文件 | 颜色 | 其中可映射 | px | 其中可映射 | 时长 | 其中可映射 |')
  L('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const stat of perFile.values()) {
    L(
      `| \`${stat.file}\` | ${stat.color} | ${stat.colorHit} | ${stat.length} | ${stat.lengthHit} | ${stat.time} | ${stat.timeHit} |`
    )
  }
  const total = [...perFile.values()].reduce(
    (acc, s) => ({
      color: acc.color + s.color,
      colorHit: acc.colorHit + s.colorHit,
      length: acc.length + s.length,
      lengthHit: acc.lengthHit + s.lengthHit,
      time: acc.time + s.time,
      timeHit: acc.timeHit + s.timeHit
    }),
    { color: 0, colorHit: 0, length: 0, lengthHit: 0, time: 0, timeHit: 0 }
  )
  L(
    `| **合计** | **${total.color}** | **${total.colorHit}** | **${total.length}** | **${total.lengthHit}** | **${total.time}** | **${total.timeHit}** |`
  )
  L('')
  L('## 2. 无对应令牌的值（语义缺口）')
  L('')
  const gaps = [...unmapped.values()].sort((a, b) => b.count - a.count)
  if (!gaps.length) L('（无）')
  else {
    L('| 值 | 类别 | 出现次数 | 文件 |')
    L('| --- | --- | ---: | --- |')
    for (const g of gaps.slice(0, 60)) {
      L(`| \`${g.value}\` | ${g.kind} | ${g.count} | ${[...g.files].sort().join(', ')} |`)
    }
    if (gaps.length > 60) L(`| … | | | 其余 ${gaps.length - 60} 条省略 |`)
  }
  L('')
  L('## 3. 定义了但没被引用的令牌')
  L('')
  L(unused.length ? unused.map((n) => `- \`${n}\``).join('\n') : '（无）')
  L('')
  L('## 4. 同一令牌有多个值（主题差异或重复定义）')
  L('')
  if (!duplicate.length) L('（无）')
  else {
    L('| 令牌 | 值 | 定义于 |')
    L('| --- | --- | --- |')
    for (const name of duplicate) {
      const info = tokens.get(name)
      L(`| \`${name}\` | ${[...info.values].join(' / ')} | ${[...info.files].join(', ')} |`)
    }
  }
  L('')
  L('## 5. 概况')
  L('')
  L(`- 令牌总数：${tokens.size}（被引用 ${tokens.size - unused.length}）`)
  L(`- 令牌引用点：${[...refs.values()].reduce((a, b) => a + b, 0)}（含组件内联 style）`)
  L('')
  return lines.join('\n')
}

const report = analyse()
if (process.argv.includes('--check')) {
  /* 门禁：散落值清单必须与当前样式一致（V-0 D1 的同类漂移） */
  const file = join(root, 'docs/design/CSS-散落值清单.md')
  const content = renderMarkdown(report).replace(/\n+$/, '') + '\n'
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing !== content) {
    console.error(`✗ ${file} 与当前样式不一致 —— 跑 npm run measure:css 重新生成`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${file} 与当前样式一致`)
  }
} else if (process.argv.includes('--md')) {
  const file = join(root, 'docs/design/CSS-散落值清单.md')
  writeFileSync(file, renderMarkdown(report).replace(/\n+$/, '') + '\n')
  console.log(`已写入 ${file}`)
  const t = [...report.perFile.values()].reduce(
    (a, s) => ({ c: a.c + s.color, l: a.l + s.length, m: a.m + s.time, hit: a.hit + s.colorHit + s.lengthHit + s.timeHit }),
    { c: 0, l: 0, m: 0, hit: 0 }
  )
  console.log(`  颜色 ${t.c} / px ${t.l} / 时长 ${t.m}，其中可映射 ${t.hit}`)
  console.log(`  无对应令牌 ${report.unmapped.size} 种，未被引用的令牌 ${report.unused.length} 个`)
} else {
  console.log(renderMarkdown(report))
}
