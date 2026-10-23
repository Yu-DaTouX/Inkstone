#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = join(root, '.tmp', 'artifact-lint', 'unit')
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })

const outDir = join(workDir, 'out')
await build({
  entryPoints: ['src/main/artifact-lint.ts', 'src/main/artifact-preview-command.ts'],
  outdir: outDir,
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { lintArtifactHtml, formatArtifactLint } = await import(pathToFileURL(join(outDir, 'main', 'artifact-lint.js')).href)
const { runArtifactPreview } = await import(pathToFileURL(join(outDir, 'main', 'artifact-preview-command.js')).href)

let checks = 0
const ids = (html) => lintArtifactHtml(html).map((finding) => finding.id)
const has = (html, id, label) => {
  assert.ok(ids(html).includes(id), `${label}（实际：${ids(html).join(', ') || '无'}）`)
  checks++
}
const lacks = (html, id, label) => {
  assert.ok(!ids(html).includes(id), `${label}（实际：${ids(html).join(', ')}）`)
  checks++
}
const page = (style, body = '') => `<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`

const clean = page(
  ':root{--bg:#F7F3EA;--ink:#141414;--muted:#595959;--accent:#C1121F}body{background:var(--bg);color:var(--ink)}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:12px}h1{font-size:72px;text-transform:uppercase;letter-spacing:-0.02em}',
  '<p class="eyebrow">Q3 report</p><h1>活动名称</h1><a href="https://www.abs.gov.au/">ABS</a><svg xmlns="http://www.w3.org/2000/svg"></svg>'
)
assert.deepEqual(lintArtifactHtml(clean), [], '干净页面没有发现')
checks++

has(page('.hero{background:linear-gradient(135deg,#6366f1,#ec4899)}'), 'purple-gradient', '靛蓝渐变')
has(page('.hero{background:linear-gradient(90deg, rgba(0,0,0,.2), purple)}'), 'purple-gradient', 'purple 关键字渐变（含嵌套括号）')
has(page('.hero{background:linear-gradient(90deg,#3b82f6,#06b6d4)}'), 'trust-gradient', '蓝青信任渐变')
lacks(page('.hero{background:linear-gradient(90deg,#6366f1,#06b6d4)}'), 'ai-default-indigo', '已报紫色渐变时不重复报靛蓝')
has(page('.btn{background:#4F46E5}'), 'ai-default-indigo', '直接写默认靛蓝')
lacks(page(':root{--accent:#4f46e5}.btn{background:var(--accent)}'), 'ai-default-indigo', ':root 里定义成令牌时不报')
has(page('', '<h3>🚀 快速上手</h3>'), 'emoji-icon', '标题里的 emoji 图标')
lacks(page('', '<p>今天很开心 🎉</p>'), 'emoji-icon', '正文里的 emoji 不报')
has(page('.card{border-left:4px solid var(--accent);border-radius:12px}'), 'left-accent-card', '左边框圆角卡片')
lacks(page('.card{border-left:4px solid var(--accent);border-radius:0}'), 'left-accent-card', '直角左边框不报')
has(page('', '<p>10× faster builds</p>'), 'invented-metric', '编造指标')
has(page('', '<p>Lorem ipsum dolor sit amet</p>'), 'filler-copy', 'lorem 填充文案')
has(page('', '<img src="https://images.unsplash.com/x.jpg">'), 'external-resource', '网络图片')
has(page('@import url("https://fonts.googleapis.com/css2?family=Inter");'), 'external-resource', '网络字体')
has(page('', '<script src="//cdn.jsdelivr.net/npm/gsap"></script>'), 'external-resource', '协议相对 CDN 脚本')
lacks(page('.bg{background:url(data:image/png;base64,iVBORw0KGgo=)}', '<img src="data:image/png;base64,AAAA"><img src="logo.png">'), 'external-resource', 'data: 与相对路径不报')
has(page('.tag{text-transform:uppercase;font-size:12px}'), 'all-caps-no-tracking', '全大写没字距')
has(page('.tag{text-transform:uppercase;font-size:20px;letter-spacing:0.5px}'), 'all-caps-no-tracking', 'px 字距按字号算比例')
has(page('', '<span style="text-transform: uppercase">new</span>'), 'all-caps-no-tracking', '行内全大写')
lacks(page('.tag{text-transform:uppercase;letter-spacing:var(--caps)}'), 'all-caps-no-tracking', 'var() 字距不判')
lacks(page('h1{text-transform:uppercase;font-size:clamp(48px,8vw,120px);letter-spacing:-0.01em}'), 'all-caps-no-tracking', '展示大字不查')
lacks(page('/* .x{text-transform:uppercase} */'), 'all-caps-no-tracking', 'CSS 注释不查')
const hexes = Array.from({ length: 13 }, (_, i) => `.c${i}{color:#${String(i).padStart(2, '0')}3344}`).join('')
has(page(hexes), 'raw-hex', ':root 外散写 13 个色值')
lacks(page(`:root{${Array.from({ length: 20 }, (_, i) => `--c${i}:#${String(i).padStart(2, '0')}3344;`).join('')}}`), 'raw-hex', ':root 里的色值不算')
has(page('', Array.from({ length: 7 }, () => '<b style="color:var(--accent)">x</b>').join('')), 'accent-overuse', '行内强调色超过 6 次')
lacks(page('<!-- .hero{background:linear-gradient(#6366f1,#fff)} -->'), 'purple-gradient', 'HTML 注释不查')
lacks(page(':root{--accent2:#A78BFA}.glow{background:radial-gradient(circle,#a78bfa,transparent)}'), 'purple-gradient', '风格牌在 :root 声明的颜色不算 AI 默认紫')

const bigBase64 = 'A'.repeat(3_000_000)
const started = Date.now()
lintArtifactHtml(page(`.bg{background:url(data:image/png;base64,${bigBase64})}`, `<img src="data:image/png;base64,${bigBase64}">`))
assert.ok(Date.now() - started < 2000, `3MB 内联图片 2 秒内查完（${Date.now() - started}ms）`)
checks++

const lines = formatArtifactLint(lintArtifactHtml(page('.tag{text-transform:uppercase}.btn{background:#4f46e5}')))
assert.ok(lines[0].startsWith('[必须改] ai-default-indigo'), '必须改排在前面')
assert.ok(lines[1].startsWith('[建议改] all-caps-no-tracking'), '建议改排在后面')
checks += 2

const htmlPath = join(workDir, 'slop.html')
await writeFile(htmlPath, page('.hero{background:linear-gradient(90deg,#3b82f6,#06b6d4)}'))
const fakePreview = async () => ({ shots: [{ scheme: 'light', viewport: 'desktop', path: 'a.png', horizontalOverflow: false }], consoleErrors: [] })
const withLint = await runArtifactPreview(fakePreview, 'slop.html', workDir)
assert.equal(withLint.summary.lint.length, 1, '预览摘要带 lint')
assert.ok(withLint.summary.lint[0].includes('trust-gradient'), 'lint 写明规则 id')
assert.ok(String(withLint.summary.note).includes('[必须改]'), '有发现时说明怎么处理')
assert.equal(withLint.data.lint[0].level, 'must', 'data 里保留结构化发现')
checks += 4

const cleanPath = join(workDir, 'clean.html')
await writeFile(cleanPath, clean)
const noLint = await runArtifactPreview(fakePreview, cleanPath, workDir)
assert.deepEqual(noLint.summary.lint, [], '干净页面 lint 为空')
assert.ok(!String(noLint.summary.note).includes('[必须改]'), '没发现时不加说明')
checks += 2

const videoPreview = async () => ({
  shots: [],
  consoleErrors: [],
  video: { compositionId: 'demo', width: 1920, height: 1080, duration: 4, timelineReady: true, screenWidth: 1280, screenHeight: 720, sheetPath: 's.png', samples: [] }
})
const videoLint = await runArtifactPreview(videoPreview, 'slop.html', workDir)
assert.equal(videoLint.summary.lint.length, 1, '视频合成也带 lint')
checks++

console.log(`artifact lint: ${checks} checks passed`)
