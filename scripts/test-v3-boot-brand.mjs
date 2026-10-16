import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DESIGN_PATH, readDesign, validateDesign } from './lib/brand.mjs'
import { BOOT_HTML, projectBootHtml, renderBootSvg } from './design/sync-boot-brand.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const abs = (rel) => `${root}${rel}`
const read = (rel) => readFileSync(abs(rel), 'utf8')

const BOOT_RE = /[ \t]*<svg class="boot-mark"[\s\S]*?<\/svg>/g
const BOOT_PATH_RE = /<path\b[^>]*\/>/g

const OLD_PATHS = [
  'M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53',
  'M36 40L47 50L36 60',
  'M57 62H69'
]

function parseBootSvg(html) {
  const matches = html.match(BOOT_RE) ?? []
  assert.equal(matches.length, 1, `${BOOT_HTML} 应恰好有一个 .boot-mark 启动画面 SVG，实际 ${matches.length} 个`)
  return matches[0]
}

function parsePaths(svg) {
  return (svg.match(BOOT_PATH_RE) ?? []).map((tag) => ({
    tag,
    className: /class="([^"]*)"/.exec(tag)?.[1],
    d: /d="([^"]*)"/.exec(tag)?.[1],
    normalizedLength: /pathLength="1"/.test(tag),
    strokeWidth: /stroke-width="([^"]*)"/.exec(tag)?.[1],
    linecap: /stroke-linecap="([^"]*)"/.exec(tag)?.[1],
    linejoin: /stroke-linejoin="([^"]*)"/.exec(tag)?.[1]
  }))
}

function assertGeometry(actual, source, label) {
  assert.equal(actual.strokeWidth, String(source.strokeWidth), `${label} 线宽应来自真源 strokeWidth`)
  if (source.linecap) assert.equal(actual.linecap, source.linecap, `${label} 端点应来自真源 linecap`)
  else assert.equal(actual.linecap, undefined, `${label} 真源无 linecap 时不应写端点属性`)
  if (source.linejoin) assert.equal(actual.linejoin, source.linejoin, `${label} 连接应来自真源 linejoin`)
  else assert.equal(actual.linejoin, undefined, `${label} 真源无 linejoin 时不应写连接属性`)
}

const { design } = readDesign(abs(DESIGN_PATH))
validateDesign(design)

const html = read(BOOT_HTML)
const svg = parseBootSvg(html)
const paths = parsePaths(svg)
const { viewBox, frame, prompt } = design.geometry

assert.equal(paths.length, 3, '启动画面应恰好三条路径：石框、提示符、光标')
assert.equal(
  svg.match(/viewBox="([^"]*)"/)?.[1],
  viewBox.join(' '),
  '启动画面 viewBox 应来自真源 geometry.viewBox'
)

assert.equal(paths[0].className, 'boot-frame', '第一条应是 .boot-frame')
assert.equal(paths[0].d, frame.path, '石框路径应逐字来自真源 geometry.frame.path')
assert.ok(paths[0].normalizedLength, '石框需保留 pathLength="1" 以驱动描画动画')
assertGeometry(paths[0], frame, '石框')

assert.equal(paths[1].className, 'boot-prompt', '第二条应是 .boot-prompt')
assert.equal(paths[1].d, prompt[0].path, '提示符路径应逐字来自真源 geometry.prompt[0].path')
assertGeometry(paths[1], prompt[0], '提示符')

assert.equal(paths[2].className, 'boot-cursor', '第三条应是 .boot-cursor')
assert.equal(paths[2].d, prompt[1].path, '光标路径应逐字来自真源 geometry.prompt[1].path')
assertGeometry(paths[2], prompt[1], '光标')

for (const oldPath of OLD_PATHS) {
  assert.ok(!svg.includes(oldPath), `启动画面仍残留旧硬编码几何：${oldPath}`)
}

assert.equal(projectBootHtml(html, design), html, `${BOOT_HTML} 与真源投影不一致（运行 npm run icon 重新生成）`)
assert.equal(renderBootSvg(design), svg, 'renderBootSvg 输出应与 index.html 中的启动画面逐字一致')
assert.equal(projectBootHtml(projectBootHtml(html, design), design), projectBootHtml(html, design), '投影应幂等')

const stripBoot = (source) => source.replace(BOOT_RE, '')
const mutated = structuredClone(design)
mutated.geometry.frame.path = 'M0 0H1'
mutated.geometry.frame.strokeWidth = 9.5
mutated.geometry.prompt[0].linecap = 'round'
mutated.geometry.prompt[1].strokeWidth = 2.25
const projected = projectBootHtml(html, mutated)
assert.notEqual(projected, html, '几何变化后投影应随之变化')
assert.ok(projected.includes('d="M0 0H1"'), '投影应写入新的石框路径')
assert.ok(projected.includes('stroke-width="9.5"'), '真源线宽变化应投影到启动画面')
assert.ok(projected.includes('stroke-linecap="round"'), '真源端点变化应投影到启动画面')
assert.ok(projected.includes('stroke-width="2.25"'), '真源光标线宽变化应投影到启动画面')
assert.equal(stripBoot(projected), stripBoot(html), '投影只能改启动画面，其余 HTML 必须逐字不动')

assert.throws(() => projectBootHtml('<p>没有启动画面</p>', design), /恰好一个/, '缺少启动画面时应报错')
const oneSegment = structuredClone(design)
oneSegment.geometry.prompt = oneSegment.geometry.prompt.slice(0, 1)
assert.throws(() => renderBootSvg(oneSegment), /恰好两段/, '真源提示符段数变化时应报错，而不是静默错位')

const buildIcon = read('scripts/build-icon.mjs')
assert.match(buildIcon, /from\s*'\.\/design\/sync-boot-brand\.mjs'/, 'build-icon 应导入启动画面投影模块')
assert.match(buildIcon, /syncBootBrand\(\{\s*root,\s*design,\s*checkOnly\s*\}\)/, 'build-icon 应同时用于写入与校验')

const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.scripts.icon, 'electron scripts/build-icon.mjs', 'npm run icon 仍是唯一图标生成入口')
assert.equal(pkg.scripts['check:brand'], 'electron scripts/build-icon.mjs --check', 'npm run check:brand 仍是唯一品牌校验入口')
const extraEntries = Object.entries(pkg.scripts).filter(([, command]) => /sync-boot-brand/.test(command))
assert.equal(extraEntries.length, 0, `不应为启动画面投影新增第二个正式入口：${extraEntries.map(([name]) => name).join(', ')}`)

assert.ok(!/\b(?:href|src)\s*=/.test(svg), '启动画面 SVG 不应引用外部资源')
assert.ok(!/<image\b/.test(svg), '启动画面 SVG 不应嵌入 <image>')
assert.ok(!/url\(/.test(svg), '启动画面 SVG 不应有 url() 外部引用')
assert.ok(!/inkstone-design\.json/.test(html), '入口 HTML 不应在运行时引用品牌真源文件')

const syncSource = read('scripts/design/sync-boot-brand.mjs')
assert.ok(!/from\s*'electron'/.test(syncSource) && !/from\s*"electron"/.test(syncSource), '启动画面投影应是生成期纯 Node 脚本')

for (const file of readdirSync(abs('src/renderer'), { recursive: true })) {
  if (!/\.(?:ts|tsx|css|html)$/.test(file)) continue
  const target = join(abs('src/renderer'), file)
  assert.ok(
    !readFileSync(target, 'utf8').includes('sync-boot-brand'),
    `渲染端不应 import 生成脚本（会造成启动资源等待）：${target}`
  )
}

const BOOT_RULE_RE = /\.boot[a-z-]*[^{}]*\{([^}]*)\}/g
for (const rel of ['src/renderer/src/design/base.css', 'src/renderer/src/styles/motion.css']) {
  const css = read(rel)
  const rules = [...css.matchAll(BOOT_RULE_RE)]
  assert.ok(rules.length > 0, `${rel} 应有启动画面样式规则`)
  for (const [, body] of rules) {
    for (const prop of ['stroke-width', 'stroke-linecap', 'stroke-linejoin']) {
      assert.ok(
        !new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(body),
        `${rel} 的启动画面规则不得声明 ${prop}，否则会盖过真源投影：${body.trim()}`
      )
    }
  }
}

console.log('启动画面品牌检查通过：几何与线宽/端点只来自真源、投影只改 boot 段、CSS 不覆盖几何、接线在图标生成入口、启动无额外资源等待。')
