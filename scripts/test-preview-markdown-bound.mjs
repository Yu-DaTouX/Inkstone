import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source = await readFile('src/renderer/src/components/toolbar/FilePreview.tsx', 'utf8')
const start = source.indexOf('  const markdownText = useMemo(')
const snippet = source.slice(start, source.indexOf('\n  /*', start))
for (const text of ['x'.repeat(2000000), 'x'.repeat(65535) + '😀']) {
 const context = { lines: [text], MAX_MARKDOWN_CHARS: 65536, useMemo: fn => fn() }
 runInNewContext(snippet + '\nglobalThis.value=markdownText', context)
 assert.ok(context.value.length <= 65536)
 assert.ok(!(context.value.charCodeAt(context.value.length - 1) >= 0xd800 && context.value.charCodeAt(context.value.length - 1) <= 0xdbff))
}
assert.doesNotMatch(source, /lines.length === MAX_RENDER_LINES/)
console.log('preview-markdown-bound: 5 assertions passed (现场纯计算，不启动渲染窗口)')
