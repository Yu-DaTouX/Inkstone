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

/** 抹掉注释但保留换行（行号才对得上） */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

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

  if (name !== KEYFRAME_FILE) {
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
      const line = css.slice(0, m.index).split('\n').length
      problems.push(`${name}:${line} 模块 CSS 不允许定义 @keyframes ${m[1]}（应放 ${KEYFRAME_FILE}）`)
    }
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
    ['a.css', '.x { animation: mo-in-up var(--dur-200) var(--ease) both; }', '规范写法', false]
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
  console.log('✓ 自检通过（10 个用例）')
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

const unused = [...known].filter((n) => !usedNames.has(n))

if (problems.length) {
  console.error(`✗ 动效检查失败（${problems.length} 项）：`)
  for (const p of problems) console.error('   ' + p)
  process.exit(1)
}
console.log(`✓ 动效检查通过 · ${known.size} 个关键帧集中在 ${KEYFRAME_FILE}`)
if (unused.length) console.log(`   定义了但没人用（建议删）：${unused.join(', ')}`)
