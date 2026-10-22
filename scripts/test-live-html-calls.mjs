import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-live-html-calls-'))
try {
  const outfile = join(dir, 'calls.mjs')
  await build({ entryPoints: ['src/renderer/src/features/preview/live-html-calls.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const m = await import(pathToFileURL(outfile).href)

  const html = '<!doctype html>\n<p class="a">中文 \\ "引号"</p>\t<script>x()</script>'
  const full = JSON.stringify({ path: 'artifacts/poster.html', content: html })
  assert.equal(m.partialJsonContent(full), html, '完整参数还原内容')
  for (let cut = 0; cut <= full.length; cut++) {
    const part = m.partialJsonContent(full.slice(0, cut))
    if (part === null) continue
    assert.ok(html.startsWith(part), `截断在 ${cut} 时得到内容前缀`)
  }
  assert.equal(m.partialJsonContent('{"path":"a.html","content":"\\u4e2'), '', '不完整的 \\u 转义不输出半个字符')
  assert.equal(m.partialJsonContent('{"path":"a.html"'), null, '还没开始写内容')

  const user = { id: 'm0', role: 'user', text: 'hi' }
  const streaming = {
    id: 'm1',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 't1', name: 'write', args: undefined, argsRaw: full.slice(0, 60), status: 'running' }]
  }
  const calls = m.currentTurnHtmlCalls([user, streaming])
  assert.equal(calls.length, 1, '流式中只靠 argsRaw 也能识别 HTML 写入')
  assert.equal(calls[0].path, 'artifacts/poster.html')
  assert.equal(calls[0].done, false)
  assert.ok(html.startsWith(calls[0].draft), '草稿是内容前缀')

  const finished = { ...streaming, toolCalls: [{ id: 't1', name: 'write', args: { path: 'artifacts/poster.html', content: html }, argsRaw: full, status: 'ok' }] }
  const done = m.currentTurnHtmlCalls([user, finished])
  assert.equal(done[0].done, true)
  assert.equal(done[0].draft, html)

  const edit = { ...streaming, toolCalls: [{ id: 't2', name: 'edit', args: { path: 'a.html', oldText: 'x', newText: 'y' }, status: 'running' }] }
  assert.equal(m.currentTurnHtmlCalls([user, edit])[0].draft, null, 'edit 不产生草稿')
  const css = { ...streaming, toolCalls: [{ id: 't3', name: 'write', argsRaw: '{"path":"a.css","content":"b', status: 'running' }] }
  assert.equal(m.currentTurnHtmlCalls([user, css]).length, 0, '非 HTML 不跟随')

  assert.equal(m.visibleSnippet('<h2 class="t">\u5c55\u671f &amp; \u5730\u70b9</h2>'), '\u5c55\u671f & \u5730\u70b9', '\u53d6\u6807\u7b7e\u95f4\u53ef\u89c1\u6587\u5b57\u5e76\u89e3\u7801\u5b9e\u4f53')
  assert.equal(m.visibleSnippet('.poster{width:100%}'), null, 'CSS \u7247\u6bb5\u6ca1\u6709\u7126\u70b9')
  assert.equal(m.visibleSnippet('\u57ce\u5e02\u7f8e\u672f\u9986'), '\u57ce\u5e02\u7f8e\u672f\u9986', '\u7eaf\u6587\u5b57\u66ff\u6362')
  assert.equal(m.visibleSnippet('="x">\u6807\u9898\u6587\u5b57</span><b'), '\u6807\u9898\u6587\u5b57', '\u5207\u6389\u534a\u4e2a\u6807\u7b7e')
  assert.equal(m.visibleSnippet('<style>.a{}</style><p>12</p><p>\u65b0\u7684\u4e3b\u9898\u8bed</p>'), '\u65b0\u7684\u4e3b\u9898\u8bed', '\u8df3\u8fc7\u6837\u5f0f\u548c\u7eaf\u6570\u5b57')
  const editFocus = { ...streaming, toolCalls: [{ id: 't4', name: 'edit', args: { path: 'a.html', edits: [{ oldText: 'a', newText: '.x{color:red}' }, { oldText: 'b', newText: '<p>\u6539\u8fc7\u7684\u6587\u6848</p>' }] }, status: 'ok', endedAt: 5 }] }
  const focusCall = m.currentTurnHtmlCalls([user, editFocus])[0]
  assert.equal(focusCall.focusText, '\u6539\u8fc7\u7684\u6587\u6848', 'edits \u6570\u7ec4\u91cc\u53d6\u7b2c\u4e00\u5904\u53ef\u89c1\u6587\u5b57')
  assert.equal(focusCall.endedAt, 5)
  assert.equal(calls[0].focusText, null, 'write \u6ca1\u6709\u6587\u5b57\u7126\u70b9')

  const sharedOut = join(dir, 'shared.mjs')
  await build({ entryPoints: ['src/shared/html-artifact-preview.ts'], outfile: sharedOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const s = await import(pathToFileURL(sharedOut).href)
  const page = '<!DOCTYPE html>\n<html><body>x</body></html>'
  const served = s.withPreviewRuntime(page)
  assert.ok(served.startsWith('<!DOCTYPE html><style data-yan-preview>'), '\u8fd0\u884c\u65f6\u63d2\u5728 doctype \u4e4b\u540e\uff0c\u4e0d\u89e6\u53d1\u602a\u5f02\u6a21\u5f0f')
  assert.ok(served.endsWith('\n<html data-yan-src="16"><body data-yan-src="22">x</body></html>'), '原文保留在运行时之后，元素带源码偏移供微调写回')
  assert.ok((served.match(/<\/script>/g) || []).length === 2 && served.lastIndexOf('</script>') < served.indexOf('<html'), '预览运行时与画布桥接各一个脚本，都在页面原文之前')
  assert.ok(s.withPreviewRuntime('<p>a</p>').startsWith('<style data-yan-preview>'), '\u6ca1\u6709 doctype \u65f6\u653e\u5728\u6700\u524d')
  assert.ok(s.withPreviewRuntime('\uFEFF<!DOCTYPE html>\n<html><body>x</body></html>').endsWith('\n<html data-yan-src="16"><body data-yan-src="22">x</body></html>'), '带 BOM 的文件，源码偏移与去掉 BOM 的编辑视图对齐')
  const script = served.slice(served.indexOf('<script data-yan-preview>') + 25, served.indexOf('</script>'))
  assert.ok(script.startsWith('(function(){\nvar parent=window.parent;'), '预览运行时先固定宿主窗口，页面替换 window.parent 后仍能响应定位')
  assert.doesNotThrow(() => new Function(script), '\u8fd0\u884c\u65f6\u811a\u672c\u8bed\u6cd5\u6b63\u786e')
  assert.deepEqual(s.readProbeReply({ 'yan-preview': 'probe', id: 3, rect: { x: 1, y: 2, w: 3, h: 4 }, docHeight: 900 }), { id: 3, rect: { x: 1, y: 2, w: 3, h: 4 }, docHeight: 900 })
  assert.equal(s.readProbeReply({ 'yan-preview': 'probe', id: 3, rect: { x: 'a' } }).rect, null, '\u4f2a\u9020\u7684\u5750\u6807\u88ab\u4e22\u5f03')
  assert.equal(s.readProbeReply({ id: 3 }), null)

  {
  const page = '<!doctype html><html><head><style>body{margin:0}</style></head><body>' + '<p>段落</p>'.repeat(40)
  assert.equal(m.htmlInText('先想一下 `<html>` 标签怎么用'), null, '短片段不算草稿')
  const fenced = m.htmlInText('方向定了。\n```html\n' + page + '</body></html>\n```\n再检查一下')
  assert.ok(fenced.startsWith('<!doctype html>') && fenced.endsWith('</html>'), '取到完整 HTML，不含围栏后的文字')
  assert.ok(m.htmlInText('```html\n' + page).endsWith('<p>段落</p>'), '未写完的草稿取到当前末尾')
  const second = m.htmlInText(page + '</html>\n改一版：\n' + page.replace('段落', '第二版'))
  assert.ok(second.includes('第二版'), '多份草稿取最后一份')
  const thinking = (calls) => [{ id: 'u', role: 'user', text: 'x' }, { id: 'a', role: 'assistant', text: '', thinking: page, toolCalls: calls }]
  assert.ok(m.thinkingHtmlDraft(thinking([])), '思考里的 HTML 作为草稿')
  assert.equal(m.thinkingHtmlDraft(thinking([{ id: 'w', name: 'write', args: {}, status: 'running' }])), null, '同一条消息已开始写文件时以工具参数为准')
}

console.log('live html calls: partial content / streaming path / draft / focus / runtime passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}
