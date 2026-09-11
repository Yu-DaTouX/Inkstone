/**
 * 补回 `i-settings`：它被代码使用（Rail 的设置按钮），但设计稿
 * prototype.html 的 sprite 区块里没有 —— 两边本来就不一致。
 *
 * 后果：跑 `npm run icons`（extract-icons.mjs 从 prototype.html 抽）会把
 * sprite.ts 里那个 symbol 删掉，`<Icon name="settings" />` 变成空图标。
 *
 * 这个脚本把 HEAD 版本 sprite.ts 里的 i-settings 取回，写进 prototype.html。
 * 幂等：已经有了就跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const head = execSync('git show HEAD:src/renderer/src/icons/sprite.ts', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})

// sprite.ts 里 ICON_SPRITE 是一个 JSON 字符串字面量，先取出来再解转义
const jm = /export const ICON_SPRITE = ("(?:[^"\\]|\\.)*")/.exec(head)
if (!jm) {
  console.error('✗ 取不到 ICON_SPRITE')
  process.exit(1)
}
const sprite = JSON.parse(jm[1])

const sm = /<symbol id="i-settings"[\s\S]*?<\/symbol>/.exec(sprite)
if (!sm) {
  console.error('✗ HEAD 里没有 i-settings')
  process.exit(1)
}

const P = 'docs/design/prototype.html'
let html = readFileSync(P, 'utf8')
if (html.includes('id="i-settings"')) {
  console.log('• i-settings 已存在，跳过')
  process.exit(0)
}

const s = html.indexOf('<!-- ICON-SPRITE-START -->')
const e = html.indexOf('<!-- ICON-SPRITE-END -->')
if (s < 0 || e < 0) {
  console.error('✗ 找不到 ICON-SPRITE 标记')
  process.exit(1)
}

const block = html.slice(s, e)
const at = block.lastIndexOf('</svg>')
if (at < 0) {
  console.error('✗ sprite 区块里没有 </svg>')
  process.exit(1)
}

const NOTE = '<!-- 代码在用但设计稿 sprite 漏掉的：i-settings。补进来避免 npm run icons 把它删掉。 -->'
html = html.slice(0, s) + block.slice(0, at) + NOTE + sm[0] + block.slice(at) + html.slice(e)
writeFileSync(P, html)
console.log('✓ 已把 i-settings 补进 prototype.html')
