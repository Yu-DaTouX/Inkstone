import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { DESIGN_PATH, GEOMETRY_OUT, readDesign, renderGeometryModule } from './lib/brand.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const abs = (rel) => `${root}${rel}`
const read = (rel) => readFileSync(abs(rel), 'utf8')

const CHROME_TSX = 'src/renderer/src/t3/components/sidebar/SidebarChrome.tsx'
const SIDEBAR_TSX = 'src/renderer/src/features/sidebar/Sidebar.tsx'
const BRAND_MARK = 'src/renderer/src/features/sidebar/BrandMark.tsx'
const DESIGN_ENTRY = 'src/renderer/src/design/index.css'
const V3_STYLE_DIRS = [
  'src/renderer/src/design',
  'src/renderer/src/ui',
  'src/renderer/src/patterns',
  'src/renderer/src/features',
  'src/renderer/src/t3'
]

const chrome = read(CHROME_TSX)
assert.ok(
  /import\s*\{\s*BrandMark\s*\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/features\/sidebar\/BrandMark['"]/.test(chrome),
  `${CHROME_TSX} 应从 features/sidebar/BrandMark 导入 BrandMark`
)

const brandEntry = chrome.match(/<span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">[\s\S]*?<\/span>\s*\)/)
assert.ok(brandEntry, `${CHROME_TSX} 应有品牌入口`)
assert.ok(/<BrandMark\b[^>]*\bsize=\{14\}/.test(brandEntry[0]), '品牌入口应渲染 <BrandMark size={14}>')
assert.ok(/<BrandMark\b[^>]*\bdecorative\b/.test(brandEntry[0]), '品牌入口的 BrandMark 应为装饰性（旁边「Inkstone」字给名称）')
assert.ok(brandEntry[0].includes('{brandLabel}'), '品牌入口应显示字标文案')
assert.ok(chrome.includes('brandLabel = "Inkstone"'), '品牌字标默认是 Inkstone')
assert.ok(chrome.includes('data-testid="t3-sidebar-brand"'), '品牌入口有稳定测试锚点')
assert.ok(!/v3-side-mark/.test(chrome), `${CHROME_TSX} 不应再使用 .v3-side-mark 方块`)

const sidebarShell = read(SIDEBAR_TSX)
assert.ok(sidebarShell.includes('T3SidebarShell'), `${SIDEBAR_TSX} 应挂载 T3 侧栏，品牌入口随侧栏头部渲染`)

const brandMark = read(BRAND_MARK)
assert.ok(
  /from\s*'\.\.\/\.\.\/\.\.\/\.\.\/shared\/brand-geometry'/.test(brandMark),
  `${BRAND_MARK} 应从 shared/brand-geometry 导入几何`
)
for (const name of ['BRAND_VIEW_BOX', 'BRAND_FRAME', 'BRAND_PROMPT']) {
  assert.ok(brandMark.includes(name), `${BRAND_MARK} 应使用 ${name}`)
}
assert.ok(!/d="M[\d.]/.test(brandMark), `${BRAND_MARK} 不应再手写几何路径`)

const { design, hash } = readDesign(abs(DESIGN_PATH))
assert.equal(
  read(GEOMETRY_OUT),
  renderGeometryModule(design, hash),
  `${GEOMETRY_OUT} 与真源 ${DESIGN_PATH} 不一致`
)

const designEntry = read(DESIGN_ENTRY)
const v2Import = designEntry
  .split('\n')
  .filter((line) => /^\s*@import\b/.test(line))
  .find((line) => /styles\//.test(line))
assert.equal(v2Import, undefined, `${DESIGN_ENTRY} 的 @import 不应引用 v2 的 styles/`)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.css')) out.push(path)
  }
  return out
}

const APPEARANCE_PROP =
  /(?:^|[;{\s])(background(?:-color)?|border(?:-\w+)?|border-radius|color|width|height|stroke|fill|opacity|filter|box-shadow|display)\s*:/
const v3BrandMarkCss = V3_STYLE_DIRS.flatMap((dir) => (existsSync(abs(dir)) ? walk(abs(dir)) : []))
  .flatMap((file) => {
    const css = readFileSync(file, 'utf8')
    return [...css.matchAll(/([^{}]*\.brand-mark[^{}]*)\{([^}]*)\}/g)].map((match) => ({
      file,
      selector: match[1].trim(),
      body: match[2]
    }))
  })
for (const rule of v3BrandMarkCss) {
  assert.ok(
    !APPEARANCE_PROP.test(rule.body),
    `v3 样式 ${rule.file} 的 ${rule.selector} 不应定义品牌标志外观（只允许版面属性）`
  )
}

console.log('v3 侧栏品牌入口检查通过：头部复用统一 BrandMark 几何、显示 Inkstone 字标、无 .v3-side-mark 方块、v3 无旧 CSS 依赖。')
