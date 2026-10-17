import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { DESIGN_PATH, GEOMETRY_OUT, readDesign, renderGeometryModule } from './lib/brand.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const abs = (rel) => `${root}${rel}`
const read = (rel) => readFileSync(abs(rel), 'utf8')

const SIDEBAR_TSX = 'src/renderer/src/features/sidebar/Sidebar.tsx'
const SIDEBAR_CSS = 'src/renderer/src/features/sidebar/Sidebar.css'
const BRAND_MARK = 'src/renderer/src/features/sidebar/BrandMark.tsx'
const DESIGN_ENTRY = 'src/renderer/src/design/index.css'
const V3_STYLE_DIRS = [
  'src/renderer/src/design',
  'src/renderer/src/ui',
  'src/renderer/src/patterns',
  'src/renderer/src/features'
]

const sidebarTsx = read(SIDEBAR_TSX)
assert.ok(
  /import\s*\{[^}]*\bBrandMark\b[^}]*\}\s*from\s*'\.\/BrandMark'/.test(sidebarTsx),
  `${SIDEBAR_TSX} 应从 ./BrandMark 导入 BrandMark`
)

const brandEntry = sidebarTsx.match(/<span className="v3-side-brand">[\s\S]*?<\/span>/)
assert.ok(brandEntry, `${SIDEBAR_TSX} 应有 .v3-side-brand 品牌入口`)
assert.ok(/<BrandMark\b[^>]*\bsize=\{16\}/.test(brandEntry[0]), '品牌入口应渲染 <BrandMark size={16}>')
assert.ok(/<BrandMark\b[^>]*\bdecorative\b/.test(brandEntry[0]), '品牌入口的 BrandMark 应为装饰性（旁边「Inkstone」字给名称）')
assert.ok(/v3-side-name[^>]*>Inkstone</.test(brandEntry[0]), '品牌入口应显示「Inkstone」字标')
assert.ok(!/v3-side-mark/.test(brandEntry[0]), '品牌入口不应再使用 .v3-side-mark 方块')

const sidebarCss = read(SIDEBAR_CSS)
assert.ok(!/\.v3-side-mark\b/.test(sidebarCss), `${SIDEBAR_CSS} 不应残留 .v3-side-mark`)
assert.ok(!/\.v3-side-mark\b/.test(sidebarTsx), `${SIDEBAR_TSX} 不应残留 .v3-side-mark`)
assert.ok(
  /\.v3-side-brand\s+\.brand-mark\s*\{[^}]*flex:\s*none/.test(sidebarCss),
  `${SIDEBAR_CSS} 应为品牌标志保留不参与挤压的版面约束`
)

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

console.log('v3 侧栏品牌入口检查通过：BrandMark 复用统一几何、无 .v3-side-mark 方块、v3 无旧 CSS 依赖。')
