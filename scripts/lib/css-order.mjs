import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LAYER_DECL = /@layer\s+([\w\s,-]+);/
const STYLE_IMPORT = /@import\s+'\.\/([\w.-]+\.css)'(?:\s+layer\(([\w-]+)\))?\s*;/g

export const stylesDir = (root) => join(root, 'src/renderer/src/styles')

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

export function readStyleOrder(root) {
  return readStyleEntries(root).map((e) => e.name)
}

export function readStyleOrderPaths(root) {
  return readStyleOrder(root).map((name) => join(stylesDir(root), name))
}
