/**
 * 样式加载顺序与级联层的**唯一真源**。
 *
 * 以前各脚本各自硬编码一份 ORDER，后来改成解析 `App.tsx` 的 import。现在所有样式
 * 经 `styles/index.css` 按层导入，这里解析它：
 *
 *   @layer tokens, base, ui, layout, modules, overrides;
 *   @import './ui.css' layer(ui);
 *
 * 覆盖规则（与浏览器一致）：后面的层整体压过前面的层；同层内按特异性，
 * 再按出现顺序。`!important` 反过来，前面的层优先。
 * 只认 `./` 开头的本地文件 —— 第三方样式（xterm）不在本仓库的检查范围里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LAYER_DECL = /@layer\s+([\w\s,-]+);/
const STYLE_IMPORT = /@import\s+'\.\/([\w.-]+\.css)'(?:\s+layer\(([\w-]+)\))?\s*;/g

export const stylesDir = (root) => join(root, 'src/renderer/src/styles')

/**
 * 按加载顺序返回 `{ name, layer, layerIndex }`。
 * layerIndex 是层在 `@layer` 声明里的序号；未分层的文件记为 Infinity（压过所有层）。
 */
export function readStyleEntries(root) {
  const file = join(stylesDir(root), 'index.css')
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const layers = (LAYER_DECL.exec(source)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const m of source.matchAll(STYLE_IMPORT)) {
    const layer = m[2] ?? null
    const layerIndex = layer === null ? Infinity : layers.indexOf(layer)
    if (layer !== null && layerIndex < 0) throw new Error(`${m[1]} 使用了未声明的层 ${layer}`)
    out.push({ name: m[1], layer, layerIndex })
  }
  if (!out.length) throw new Error(`没能从 ${file} 解析出样式加载顺序`)
  return out
}

/** 按加载顺序返回样式文件名（不含目录），例如 `['tokens.css', 'ui.css', …]` */
export function readStyleOrder(root) {
  return readStyleEntries(root).map((e) => e.name)
}

/** 同上，但给出绝对路径，方便直接读文件 */
export function readStyleOrderPaths(root) {
  return readStyleOrder(root).map((name) => join(stylesDir(root), name))
}
