/**
 * 启动画面品牌几何投影：把唯一真源 `resources/brand/inkstone-design.json` 的几何
 * 写进 `src/renderer/index.html` 的静态 `.boot-mark` SVG。
 *
 * 启动画面写在静态 HTML 里，窗口首帧就有，数据就绪后才由 `lib/boot-splash.ts` 移除；
 * 它不能用运行时 import（那会引入额外资源等待），所以几何必须在生成阶段投影进去。
 * 这里从真源取路径、viewBox 与线宽/端点/连接（`strokeWidth` / `linecap` / `linejoin`），
 * 不手写第二套几何；配色、尺寸与描画/呼吸动画仍由启动画面样式（`design/base.css`、
 * `styles/motion.css`）负责，属于版面，不再覆盖这些几何属性。
 *
 * 更新与校验都挂在现有图标生成正式入口 `scripts/build-icon.mjs` 里（`npm run icon`
 * 写入，`npm run check:brand` 只校验），本文件不提供第二个正式入口，可单独执行仅供
 * 调试：`node scripts/design/sync-boot-brand.mjs [--check]`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_PATH, readDesign, validateDesign } from '../lib/brand.mjs'

export const BOOT_HTML = 'src/renderer/index.html'

/** 连同前导缩进一起匹配静态启动画面的那个 SVG；非贪婪，遇首个 `</svg>` 即止。 */
const BOOT_SVG_RE = /[ \t]*<svg class="boot-mark"[\s\S]*?<\/svg>/
const BOOT_SVG_RE_G = new RegExp(BOOT_SVG_RE.source, 'g')

/**
 * 真源几何 → 启动画面 SVG 字符串。
 *
 * 分组与 class 名是启动画面样式与动效的契约，必须保持不变：石框走描画动画（依赖
 * `pathLength="1"`），提示符与光标分开淡入/呼吸。真源 `geometry.prompt` 的两段依次
 * 对应 `>_`（`boot-prompt`）与光标 `_`（`boot-cursor`）。
 *
 * 每条路径的线宽与端点/连接直接写成 SVG 表现属性；启动画面 CSS 不得再声明这些属性，
 * 否则会盖过真源投影。
 */
function geometryAttrs(part) {
  const attrs = [`stroke-width="${part.strokeWidth}"`]
  if (part.linecap) attrs.push(`stroke-linecap="${part.linecap}"`)
  if (part.linejoin) attrs.push(`stroke-linejoin="${part.linejoin}"`)
  return attrs.join(' ')
}

export function renderBootSvg(design) {
  const { viewBox, frame, prompt } = design.geometry
  if (!Array.isArray(prompt) || prompt.length !== 2) {
    throw new Error(`启动画面投影需要真源 geometry.prompt 恰好两段（符号与光标），实际 ${prompt?.length ?? 0} 段`)
  }
  return [
    `      <svg class="boot-mark" viewBox="${viewBox.join(' ')}" fill="none">`,
    `        <path class="boot-frame" pathLength="1" d="${frame.path}" ${geometryAttrs(frame)} />`,
    `        <path class="boot-prompt" d="${prompt[0].path}" ${geometryAttrs(prompt[0])} />`,
    `        <path class="boot-cursor" d="${prompt[1].path}" ${geometryAttrs(prompt[1])} />`,
    `      </svg>`
  ].join('\n')
}

/**
 * 把 HTML 里的启动画面 SVG 替换为真源投影，**其余内容逐字不动**。
 * 找不到或找到多个 `.boot-mark` 都视为真源与入口错位，直接报错。
 */
export function projectBootHtml(html, design) {
  const found = html.match(BOOT_SVG_RE_G) ?? []
  if (found.length !== 1) {
    throw new Error(`${BOOT_HTML}：期望恰好一个 .boot-mark 启动画面 SVG，实际 ${found.length} 个`)
  }
  return html.replace(BOOT_SVG_RE, renderBootSvg(design))
}

/**
 * 读取入口 HTML 并与真源对齐。`checkOnly` 为真时只比较（不一致即抛错、不写文件）；
 * 否则仅在内容变化时写回。返回 { rel, changed } 供生成入口汇报。
 */
export function syncBootBrand({ root, design, checkOnly }) {
  const rel = BOOT_HTML
  const abs = join(root, rel)
  const current = readFileSync(abs, 'utf8')
  const projected = projectBootHtml(current, design)
  const changed = current !== projected
  if (checkOnly) {
    if (changed) throw new Error(`check:brand 启动画面与真源不一致：${rel}（运行 npm run icon 重新生成）`)
  } else if (changed) {
    writeFileSync(abs, projected)
  }
  return { rel, changed }
}

function isMain() {
  const entry = process.argv[1]
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const { design } = readDesign(join(root, DESIGN_PATH))
  validateDesign(design)
  const checkOnly = process.argv.includes('--check')
  const result = syncBootBrand({ root, design, checkOnly })
  if (checkOnly) {
    console.log(`启动画面投影与真源一致：${result.rel}`)
  } else {
    console.log(`${result.changed ? '已同步' : '无需改动'}启动画面投影：${result.rel}`)
  }
}
