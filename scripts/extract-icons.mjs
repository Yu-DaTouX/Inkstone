/**
 * 从设计稿 prototype.html 抽出图标 sprite，生成 renderer 用的 TS 模块。
 *
 * 为什么不让 renderer 直接 <use href="sprite.svg#id">：
 *   file:// 下 Chromium 会拦截跨文档 <use>（见 HANDOFF §8）。
 *   dev 时 renderer 是 http:// 没这问题，但 build 后是 file://，所以一律内联。
 *
 * 用法： npm run icons
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'docs/design/prototype.html')
const OUT = join(root, 'src/renderer/src/icons/sprite.ts')

const html = await readFile(SRC, 'utf8')

const m = html.match(/<!-- ICON-SPRITE-START -->([\s\S]*?)<!-- ICON-SPRITE-END -->/)
if (!m) {
  console.error('✗ 在 prototype.html 里找不到 ICON-SPRITE-START/END 标记')
  process.exit(1)
}

// <svg style="display:none"> … </svg>  —— 只取内部的 <symbol>
const svgBlock = m[1]
const symbols = [...svgBlock.matchAll(/<symbol id="([^"]+)"/g)].map((x) => x[1])
if (symbols.length === 0) {
  console.error('✗ sprite 里没有 <symbol>')
  process.exit(1)
}

const inner = svgBlock.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim()

const body = `/**
 * ⚠️ 自动生成，不要手改。
 * 来源：docs/design/prototype.html 的 ICON-SPRITE 区块（reicon, MIT）
 * 重新生成： npm run icons
 */
export const ICON_SPRITE = ${JSON.stringify(inner)}

/** sprite 里可用的图标名（去掉 i- 前缀，直接 <Icon name="search" />） */
export const ICON_NAMES = ${JSON.stringify(symbols.map((s) => s.replace(/^i-/, '')), null, 2)} as const

export type IconName = (typeof ICON_NAMES)[number]
`

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, body, 'utf8')

const kb = (Buffer.byteLength(inner) / 1024).toFixed(1)
console.log(`✓ 抽出 ${symbols.length} 个 symbol → ${kb}KB → src/renderer/src/icons/sprite.ts`)
console.log('  ' + symbols.join(' '))
