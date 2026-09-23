/**
 * 样式加载顺序的**唯一真源**（V-0）。
 *
 * 以前 `css-tokens.mjs` / `css-inventory.mjs` 各自硬编码一份 ORDER。2026-09
 * 分模块拆分与后续新增只改了 `App.tsx`，两份清单还在按旧顺序算「谁覆盖谁」——
 * 顺序错了，覆盖热力与最终值就都不可信（V-0 基线盘点发现的差异）。
 *
 * 这里直接从 `App.tsx` 解析 `import './styles/x.css'` 的出现顺序：
 * 顺序天然与运行时一致，文件改名/删除也会在生成时立刻暴露。
 * 只认 `styles/` 下的相对 import —— 其它 import 与层叠无关。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLE_IMPORT = /^import\s+'(\.\/styles\/[\w.-]+\.css)'/gm

/** 按加载顺序返回样式文件名（不含目录），例如 `['tokens.css', 'app.css', …]` */
export function readStyleOrder(root) {
  const file = join(root, 'src/renderer/src/App.tsx')
  const source = readFileSync(file, 'utf8')
  const out = []
  for (const match of source.matchAll(STYLE_IMPORT)) out.push(match[1].replace('./styles/', ''))
  if (!out.length) throw new Error(`没能从 ${file} 解析出样式加载顺序`)
  return out
}

/** 同上，但给出绝对路径，方便直接读文件 */
export function readStyleOrderPaths(root) {
  const dir = join(root, 'src/renderer/src/styles')
  return readStyleOrder(root).map((name) => join(dir, name))
}

export const stylesDir = (root) => join(root, 'src/renderer/src/styles')
