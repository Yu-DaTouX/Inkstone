import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_PATH, readDesign, validateDesign } from '../lib/brand.mjs'

export const BOOT_HTML = 'src/renderer/index.html'

const BOOT_SVG_RE = /[ \t]*<svg class="boot-mark"[\s\S]*?<\/svg>/
const BOOT_SVG_RE_G = new RegExp(BOOT_SVG_RE.source, 'g')

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

export function projectBootHtml(html, design) {
  const found = html.match(BOOT_SVG_RE_G) ?? []
  if (found.length !== 1) {
    throw new Error(`${BOOT_HTML}：期望恰好一个 .boot-mark 启动画面 SVG，实际 ${found.length} 个`)
  }
  return html.replace(BOOT_SVG_RE, renderBootSvg(design))
}

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
