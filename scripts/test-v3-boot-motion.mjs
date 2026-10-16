import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_PATH, readDesign, validateDesign } from './lib/brand.mjs'
import { BOOT_HTML, projectBootHtml, renderBootSvg } from './design/sync-boot-brand.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const BASE_CSS = 'src/renderer/src/design/base.css'
const TOKENS_CSS = 'src/renderer/src/design/tokens.css'
const INDEX_CSS = 'src/renderer/src/design/index.css'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function parseRules(css, context = '') {
  const rules = []
  let i = 0
  const n = css.length
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++
    if (i >= n) break
    const start = i
    while (i < n && css[i] !== '{' && css[i] !== '}') i++
    if (i >= n) break
    if (css[i] === '}') { i++; continue }
    const selector = css.slice(start, i).trim()
    i++
    const bodyStart = i
    let depth = 1
    while (i < n && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      if (depth === 0) break
      i++
    }
    const body = css.slice(bodyStart, i)
    i++
    if (selector.startsWith('@keyframes')) rules.push({ selector, body, context, keyframes: true })
    else if (selector.startsWith('@')) rules.push(...parseRules(body, selector.startsWith('@media') ? selector : context))
    else rules.push({ selector, body, context })
  }
  return rules
}

const selectorsOf = (rule) => rule.selector.split(',').map((s) => s.trim()).filter(Boolean)
const includesSelector = (rule, selector) => selectorsOf(rule).includes(selector)
const rulesFor = (rules, selector) => rules.filter((rule) => includesSelector(rule, selector))

const base = stripComments(read(BASE_CSS))
const rules = parseRules(base)

const bootAnchor = base.indexOf('.boot {')
assert.ok(bootAnchor >= 0, `${BASE_CSS} 应有 .boot 规则`)
const bootTail = base.slice(bootAnchor)
const bootRules = rules.filter((rule) => selectorsOf(rule).some((s) => s.startsWith('.boot')))
assert.ok(bootRules.length > 0, 'boot 段应有规则')

const bootAnimationRules = bootRules.filter((rule) => !rule.context.includes('prefers-reduced-motion'))
const bootReduceRules = bootRules.filter((rule) => rule.context.includes('prefers-reduced-motion'))
ok(bootReduceRules.length > 0, 'boot 段应有 prefers-reduced-motion 分支')

const frameRule = rulesFor(bootAnimationRules, '.boot-frame')[0]
assert.ok(frameRule, 'boot 段应有 .boot-frame 规则')
ok(/stroke-dasharray:\s*1\b/.test(frameRule.body), '.boot-frame 用 dasharray 描线（pathLength=1 的整条路径）')
ok(/stroke-dashoffset:\s*1\b/.test(frameRule.body), '.boot-frame 初始 dashoffset 为 1（看不见）')
ok(
  /animation:\s*v3-boot-draw\s+var\(--boot-ms\)\s+var\(--ease\)\s+forwards/.test(frameRule.body),
  '.boot-frame 描线时长走 --boot-ms、缓动走 --ease、forwards 落终态'
)

const promptOpacityRule = rulesFor(bootAnimationRules, '.boot-prompt').find((rule) => /opacity:\s*0\b/.test(rule.body))
ok(Boolean(promptOpacityRule), '.boot-prompt 初始不可见（opacity: 0）')
const promptAnimRule = rulesFor(bootAnimationRules, '.boot-prompt').find((rule) => /animation:/.test(rule.body))
assert.ok(promptAnimRule, '.boot-prompt 应有 animation 声明')
ok(
  /animation:\s*v3-boot-show\s+var\(--dur-pop\)\s+var\(--ease\)\s+calc\(var\(--boot-ms\)\s*\*\s*0\.75\)\s+forwards/.test(promptAnimRule.body),
  '.boot-prompt 在 --boot-ms 的 75% 处淡入'
)

const cursorOpacityRule = rulesFor(bootAnimationRules, '.boot-cursor').find((rule) => /opacity:\s*0\b/.test(rule.body))
ok(Boolean(cursorOpacityRule), '.boot-cursor 初始不可见（opacity: 0）')
const cursorAnimRule = rulesFor(bootAnimationRules, '.boot-cursor').find((rule) => /animation:/.test(rule.body))
assert.ok(cursorAnimRule, '.boot-cursor 应有 animation 声明')
const cursorAnim = cursorAnimRule.body.replace(/\s+/g, ' ')
ok(
  new RegExp('v3-boot-show\\s+var\\(--dur-pop\\)\\s+var\\(--ease\\)\\s+var\\(--boot-ms\\)\\s+forwards').test(cursorAnim),
  '.boot-cursor 在 --boot-ms 处淡入'
)
ok(
  new RegExp('v3-boot-breathe\\s+calc\\(var\\(--dur-breathe\\)\\s*/\\s*2\\)\\s+var\\(--ease\\)\\s+calc\\(var\\(--boot-ms\\)\\s*\\+\\s*var\\(--dur-pop\\)\\)\\s+infinite').test(cursorAnim),
  '.boot-cursor 淡入后按 --dur-breathe / 2（1.2s）无限呼吸'
)

const bootRule = rulesFor(bootAnimationRules, '.boot')[0]
assert.ok(bootRule, 'boot 段应有 .boot 规则')
ok(
  /--boot-ms:\s*calc\(var\(--dur-expand\)\s*\*\s*2\)/.test(bootRule.body),
  '.boot 缺省 --boot-ms 走 v3 展开档令牌（等价 v2 的 --mo-slow × 2 量级）'
)
ok(
  /animation:\s*v3-boot-out\s+240ms\s+var\(--ease\)\s+forwards/.test(rulesFor(bootAnimationRules, '.boot.out')[0]?.body ?? ''),
  '.boot.out 240ms 淡出保留'
)

const keyframes = rules.filter((rule) => rule.keyframes).map((rule) => rule.selector)
for (const [name, body] of [
  ['@keyframes v3-boot-draw', /stroke-dashoffset:\s*0/],
  ['@keyframes v3-boot-show', /opacity:\s*1/],
  ['@keyframes v3-boot-breathe', /opacity:\s*0\.35/],
  ['@keyframes v3-boot-out', /opacity:\s*0/]
]) {
  ok(keyframes.includes(name), `${name} 已定义`)
  const rule = rules.find((r) => r.keyframes && r.selector === name)
  ok(body.test(rule.body), `${name} 的关键帧内容正确`)
}
for (const bare of ['@keyframes boot-draw', '@keyframes boot-show', '@keyframes boot-breathe', '@keyframes boot-out']) {
  ok(!keyframes.includes(bare), `不复用 v2 关键帧名 ${bare.replace('@keyframes ', '')}`)
}

const reduceFrame = rulesFor(bootReduceRules, '.boot-frame')[0]
assert.ok(reduceFrame, 'reduce 分支应有 .boot-frame 规则')
ok(/stroke-dashoffset:\s*0\b/.test(reduceFrame.body), 'reduce 时石框落描线终态（dashoffset: 0）')
ok(/animation:\s*none\b/.test(reduceFrame.body), 'reduce 时石框停掉描线动画')

for (const selector of ['.boot-prompt', '.boot-cursor']) {
  const rule = rulesFor(bootReduceRules, selector).find((r) => /opacity:/.test(r.body))
  assert.ok(rule, `reduce 分支应有 ${selector} 规则`)
  ok(/opacity:\s*1\b/.test(rule.body), `reduce 时 ${selector} 直接可见（opacity: 1）`)
  ok(/animation:\s*none\b/.test(rule.body), `reduce 时 ${selector} 不呼吸、不淡入`)
}
ok(
  rules.indexOf(reduceFrame) > rules.indexOf(frameRule),
  'reduce 分支在描线声明之后，能覆盖它'
)

ok(!/motion\.css/.test(base), 'base.css 不引用 v2 的 motion.css')
ok(!/--mo-/.test(bootTail), 'boot 段不引用 v2 的 --mo-* 令牌')

const indexCss = stripComments(read(INDEX_CSS))
ok(!/styles\//.test(indexCss), 'v3 样式入口不导入 v2 的 styles/*')
ok(!/@import\s+['"]\.\.\/styles\//.test(indexCss), 'v3 样式入口没有导入 v2 模块样式')

const tokens = stripComments(read(TOKENS_CSS))
const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
const referenced = new Set([...bootTail.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]))
for (const token of ['--dur-expand', '--dur-pop', '--dur-breathe', '--ease']) {
  ok(referenced.has(token), `boot 段引用 v3 令牌 ${token}`)
}
for (const token of referenced) {
  if (token === '--boot-ms') continue
  ok(defined.has(token), `boot 段引用的 ${token} 在 tokens.css 中已定义`)
}

const { design } = readDesign(join(root, DESIGN_PATH))
validateDesign(design)
const html = read(BOOT_HTML)
const svg = /[ \t]*<svg class="boot-mark"[\s\S]*?<\/svg>/.exec(html)?.[0]
assert.ok(svg, 'index.html 应有 .boot-mark 启动画面 SVG')
ok(renderBootSvg(design) === svg, 'index.html 的启动画面仍与品牌真源逐字一致（本任务不改几何）')
ok(projectBootHtml(html, design) === html, 'index.html 与品牌真源投影一致（运行 npm run icon 仍是唯一写入入口）')

console.log(`\nv3 启动画面动效检查通过（${checks} 项）：三段动画 + 缺省时长 + v3 令牌 + reduce 终态 + 不引入 v2 样式 + 几何未变。`)
