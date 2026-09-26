/**
 * check-motion.mjs —— 动效规范的强制检查（npm run check:motion）。
 *
 * 拦四类问题：
 *   1. 模块 CSS 里又长出 @keyframes（关键帧唯一真源 = motion.css）
 *   2. animation / transition 里写裸时长（必须走 --dur / --dur-<ms> token）
 *   3. 裸写 cubic-bezier（必须走 --ease / --ease-smooth / --mo-ease*）
 *   4. animation 引用了不存在（或没定义在 motion.css）的关键帧
 * 另外报告「定义了没人用」的关键帧，防死代码堆积。
 *
 * 为什么严：动效散成 41 个关键帧 / 57 处裸时长之后，改一个节奏要翻 8 个文件，
 * 而且 reduced-motion 兜底很容易被漏掉。收口之后改 token 一处生效。
 *
 * 用法：
 *   node scripts/check-motion.mjs            # 检查
 *   node scripts/check-motion.mjs --selftest # 先证明这些规则真的能拦住违例
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STYLES = join(HERE, '..', 'src/renderer/src/styles')
/** 关键帧唯一真源 */
const KEYFRAME_FILE = 'motion.css'
const TIME = /(?<![\w.-])(\.?\d+(?:\.\d+)?)(ms|s)\b/g
const ANIM_KEYWORDS = new Set([
  'none', 'infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'step-start', 'step-end', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'forwards', 'backwards', 'both', 'running', 'paused', 'initial', 'inherit',
  'unset', 'revert', 'revert-layer', 'steps', 'cubic-bezier'
])

/** 注释配平（状态机，忽略注释正文里写的 `/*`） */
function commentBalance(raw) {
  let inComment = false
  let opened = 0
  let closed = 0
  let stray = 0
  for (let i = 0; i < raw.length; i++) {
    if (!inComment && raw[i] === '/' && raw[i + 1] === '*') {
      inComment = true
      opened++
      i++
      continue
    }
    if (raw[i] === '*' && raw[i + 1] === '/') {
      if (inComment) {
        inComment = false
        closed++
      } else {
        /* 不在注释里就遇到关闭符号：游离的，同样会吞掉后面的规则 */
        stray++
      }
      i++
    }
  }
  return { opened, closed, stray, unclosed: inComment }
}

/** 抹掉注释但保留换行（行号才对得上） */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** 全仓 CSS 里定义过的自定义属性（含局部作用域 —— 这里不区分层叠，只求不误报） */
const DEFINED_TOKENS = new Set()
const usedTokens = (css) =>
  [...css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)]
    /* 只有**没有 fallback** 的才算问题：`var(--i, 0)` 是常见的“有默认值”写法 */
    .filter((m) => m[2] === ')')
    .map((m) => ({ token: m[1], index: m.index }))
/** 警告前缀：不阻断退出码，只在最后汇总 */
const WARN = 'WARN '
for (const f of readdirSync(STYLES).filter((x) => x.endsWith('.css'))) {
  const text = stripComments(readFileSync(join(STYLES, f), 'utf8'))
  for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) DEFINED_TOKENS.add(m[1])
}

/** 抽出动画/过渡声明（可跨行） */
function motionDecls(css) {
  const re = /(animation|transition)(?:-(?:duration|delay|timing-function))?\s*:([^;{}]+)/g
  const out = []
  for (const m of css.matchAll(re)) {
    out.push({ prop: m[1], value: m[2], line: css.slice(0, m.index).split('\n').length })
  }
  return out
}

/** 关键帧定义名 */
const keyframeNames = (css) => [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])

/** 动画名引用 */
function referencedNames(decl) {
  if (decl.prop !== 'animation') return []
  return decl.value
    .replace(/!important/g, ' ')
    .replace(/var\([^)]*\)/g, ' ')
    .replace(/\b(?:cubic-bezier|steps|linear)\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .filter((t) => t && !ANIM_KEYWORDS.has(t) && !/^[-+]?[\d.]/.test(t))
}

/** 对单个文件跑规则，known = motion.css 里定义的关键帧 */
function lint(name, raw, known) {
  const css = stripComments(raw)
  const problems = []

  /*
   * 0. 注释必须配平。
   *
   * 为什么先查这个：CSS 不嵌套注释，一个多出来的 `*​/`（或缺失的 `*​/`）
   * 会把后面那段规则**静默吞掉** —— 所有“属性一致性 / 引用是否存在”的检查
   * 都看不见它（2026-09-27 实测：motion.css 里两处游离注释分别吞掉了
   * `.cborder-status` 与整个 `@keyframes pop-up`）。
   *
   * 用状态机而不是正则计数：注释正文里写 `/*` 是很常见的（如本文件的说明），
   * 正则会把它们算进去 → 误报。
   */
  const balance = commentBalance(raw)
  if (balance.unclosed || balance.stray > 0) {
    problems.push(
      `${name} 注释不配平：/* × ${balance.opened} · */ × ${balance.closed}` +
        (balance.unclosed ? '（有一个 /* 没有关，后面的规则会被吞掉）' : `（有 ${balance.stray} 个游离的 */，后面的规则会被吞掉）`)
    )
  }

  if (name !== KEYFRAME_FILE) {
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
      const line = css.slice(0, m.index).split('\n').length
      problems.push(`${name}:${line} 模块 CSS 不允许定义 @keyframes ${m[1]}（应放 ${KEYFRAME_FILE}）`)
    }
  }

  /* 引用到的令牌必须真的定义过。这里是**警告**不是错误：
     存量 CSS 里有上百处历史遗留的未定义令牌（`--fg-1` / `--line-1` / `--danger` …），
     它们在本轮之前就在了；修正需要逐处确认设计意图（对应哪个色阶），
     不适合在“规范收口”的提交里改掉。带 fallback 的 `var(--x, 默认值)` 是有意为之，不报。 */
  for (const t of usedTokens(css)) {
    if (DEFINED_TOKENS.has(t.token)) continue
    const line = css.slice(0, t.index).split('\n').length
    problems.push(`${WARN}${name}:${line} 用了未定义的令牌 ${t.token}（无 fallback → 这条声明会被丢弃）`)
  }

  for (const d of motionDecls(css)) {
    for (const m of d.value.matchAll(TIME)) {
      problems.push(`${name}:${d.line} ${d.prop} 里写裸时长 ${m[0]}（应走 var(--dur-*)）`)
    }
    const lineStart = css.lastIndexOf('\n', d.value ? css.indexOf(d.value) : 0)
    void lineStart
  }

  // 裸 cubic-bezier：自定义属性（--x:）的声明里允许 —— 那是 token 的定义处
  for (const m of css.matchAll(/cubic-bezier\(/g)) {
    const start = css.lastIndexOf('\n', m.index) + 1
    const before = css.slice(start, m.index)
    if (/--[\w-]+\s*:[^;{}]*$/.test(before)) continue
    const line = css.slice(0, m.index).split('\n').length
    problems.push(`${name}:${line} 裸写 cubic-bezier（应走 --ease / --ease-smooth / --mo-ease*）`)
  }

  if (name !== KEYFRAME_FILE) {
    for (const d of motionDecls(css)) {
      for (const ref of referencedNames(d)) {
        if (!known.has(ref)) {
          problems.push(`${name}:${d.line} animation 引用了未定义的关键帧 ${ref}`)
        }
      }
    }
  }

  return problems
}

/* ---------- selftest：先证明规则拦得住 ---------- */

function selftest() {
  const known = new Set(['mo-in-up'])
  /** [文件, CSS, 说明, 是否应该报错] */
  const cases = [
    ['a.css', '@keyframes rogue { to { opacity: 0 } }', '模块里定义 @keyframes', true],
    ['a.css', '.x { animation: mo-in-up 200ms var(--ease); }', 'animation 裸时长', true],
    ['a.css', '.x { transition: opacity 0.4s var(--ease); }', 'transition 小数秒', true],
    ['a.css', '.x { transition: opacity .8s var(--ease); }', '前导点小数秒', true],
    ['a.css', '.x { animation: mo-in-up var(--dur-200) cubic-bezier(0.2, 0, 0.2, 1); }', '裸 cubic-bezier', true],
    ['a.css', '.x { animation: nope var(--dur-200) var(--ease); }', '引用未定义关键帧', true],
    ['a.css', '/* 200ms 与 cubic-bezier(0.2,0,0.2,1) 写在注释里不算 */ .x { animation: mo-in-up var(--dur-200) var(--ease); }', '注释被忽略', false],
    ['motion.css', ':root { --mo-ease: cubic-bezier(0.22, 1, 0.36, 1); } @keyframes mo-in-up { to { opacity: 1 } }', 'motion.css 里定义关键帧与曲线 token', false],
    ['a.css', '.x { transition: visibility var(--dur-0) linear var(--dur-220); }', '已 token 化的写法', false],
    ['a.css', '.x { animation: mo-in-up var(--dur-200) var(--ease) both; }', '规范写法', false],
    ['a.css', '/* 只有开没有关\n.x { animation: mo-in-up var(--dur-200) var(--ease); }', '注释不配平要报', true],
    ['a.css', '.x { animation: mo-in-up var(--dur-200) var(--ease); }\n*/ 游离的关闭符号', '游离的注释关闭符号要报', true],
    ['a.css', '.x { animation: mo-in-up var(--nope-token); }', '未定义令牌（警告级）', true],
    ['a.css', '.x { animation: mo-in-up var(--i, 0) var(--ease); }', '带 fallback 的 var 放行', false]
  ]
  let bad = 0
  for (const [file, css, label, expectCatch] of cases) {
    const found = lint(file, css, known)
    const caught = found.length > 0
    const ok = expectCatch === caught
    if (!ok) bad++
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${expectCatch ? '' : '（应放行）'}${caught ? ' → ' + found.join(' | ') : ''}`)
  }
  if (bad) {
    console.error(`✗ 自检失败：${bad} 个用例判断错误`)
    process.exit(1)
  }
  console.log(`✓ 自检通过（${cases.length} 个用例）`)
}

if (process.argv.includes('--selftest')) {
  selftest()
  process.exit(0)
}

/* ---------- 检查 ---------- */

const files = readdirSync(STYLES).filter((f) => f.endsWith('.css'))
const known = new Set(keyframeNames(stripComments(readFileSync(join(STYLES, KEYFRAME_FILE), 'utf8'))))

const problems = []
const usedNames = new Set()
for (const file of files) {
  const raw = readFileSync(join(STYLES, file), 'utf8')
  problems.push(...lint(file, raw, known))
  for (const d of motionDecls(stripComments(raw))) for (const n of referencedNames(d)) usedNames.add(n)
}

const warnings = problems.filter((p) => p.startsWith(WARN))
const errors = problems.filter((p) => !p.startsWith(WARN))
const unused = [...known].filter((n) => !usedNames.has(n))

if (errors.length) {
  console.error(`✗ 动效检查失败（${errors.length} 项）：`)
  for (const p of errors) console.error('   ' + p)
  process.exit(1)
}
if (warnings.length) {
  /* 汇总只给类别与数量：上百条逐行打印会把真正要紧的信息冲掉 */
  const byToken = new Map()
  for (const w of warnings) {
    const token = w.match(/令牌 (--[\w-]+)/)?.[1] ?? '?'
    byToken.set(token, (byToken.get(token) ?? 0) + 1)
  }
  const top = [...byToken.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.log(`   警告：${warnings.length} 处引用了未定义的令牌（存量遗留，不阻断）：`)
  console.log('     ' + top.map(([t, n]) => `${t} × ${n}`).join(' · '))
}
console.log(`✓ 动效检查通过 · ${known.size} 个关键帧集中在 ${KEYFRAME_FILE}`)
if (unused.length) console.log(`   定义了但没人用（建议删）：${unused.join(', ')}`)
