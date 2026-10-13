import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
const source = await readFile('src/renderer/src/components/browser/BrowserSurface.tsx', 'utf8')
const start = source.indexOf('<div key={tab.id} className="ui-tab-group">')
const end = source.indexOf('</div>', start)
assert.ok(start >= 0 && end > start)
const tab = source.slice(start, end)
assert.equal((tab.match(/<button/g) ?? []).length, 2)
assert.equal((tab.match(/<\/button>/g) ?? []).length, 2)
assert.ok(tab.indexOf('</button>') < tab.indexOf('<button', tab.indexOf('<button') + 1), '关闭按钮与切换按钮同级')
await transform(source, { loader: 'tsx' })
console.log('browser-tab-buttons: 4 structure assertions + TSX transform passed (无窗口视觉验收)')
