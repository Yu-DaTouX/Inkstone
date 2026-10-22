import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outdir = join('.tmp', 'canvas-w1')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
try {
  await build({
    entryPoints: ['src/shared/html-canvas-bridge.ts', 'src/shared/html-artifact-preview.ts'],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const bridge = await import(pathToFileURL(join(outdir, 'html-canvas-bridge.js')).href)
  const preview = await import(pathToFileURL(join(outdir, 'html-artifact-preview.js')).href)

  assert.equal(bridge.HTML_CANVAS_CHANNEL, 'yan-canvas')
  assert.equal(bridge.HTML_CANVAS_TOOL_KIND, 'tool')
  assert.ok(Array.isArray(bridge.CANVAS_BRIDGE_PARTS) && bridge.CANVAS_BRIDGE_PARTS.length >= 1, '桥接片段是非空数组')
  assert.ok(bridge.CANVAS_BRIDGE_PARTS.every((part) => typeof part === 'string' && part.length > 0), '每个片段都是脚本字符串')

  const runtime = bridge.canvasBridgeRuntime()
  const open = `<script ${bridge.HTML_CANVAS_BRIDGE_MARKER}>`
  assert.ok(runtime.startsWith(open) && runtime.endsWith('</script>'), '运行时包在带标记的 script 里')
  const script = runtime.slice(open.length, -'</script>'.length)
  assert.ok(!script.includes('</script'), '片段不会提前闭合宿主 script')
  assert.ok(!/\beval\s*\(/.test(script) && !/new\s+Function/.test(script), '桥接不用 eval，符合 CSP')
  assert.ok(script.includes('ev.source!==parent'), '只接受来自父页面的消息')
  assert.ok(script.includes('parent.postMessage'), '回复只发给父页面')
  assert.ok(script.includes('"data-yan-preview"') && script.includes('"data-yan-canvas"'), '宿主注入节点被排除在路径之外')
  assert.ok(script.includes('data-yan-src'), '读取 data-yan-src 源偏移')
  assert.doesNotThrow(() => new Function(script), '注入脚本语法有效')
  assert.equal(new Function(script) instanceof Function, true)

  assert.deepEqual(bridge.canvasToolMessage('inspect'), { 'yan-canvas': 'tool', tool: 'inspect' }, '父页面工具消息带频道与工具名')
  assert.deepEqual(bridge.canvasToolMessage(null), { 'yan-canvas': 'tool', tool: '' }, '关闭时发空工具名')
  assert.ok(bridge.isCanvasBridgeTool('inspect') && bridge.isCanvasBridgeTool('comment') && bridge.isCanvasBridgeTool('edit'))
  assert.ok(!bridge.isCanvasBridgeTool('hand') && !bridge.isCanvasBridgeTool('') && !bridge.isCanvasBridgeTool(7), '只有检查/评论/编辑接管指针')

  const element = {
    path: '0.2.1',
    selector: 'section.card > h2:first-child',
    tag: 'h2',
    id: 'title',
    classes: ['headline', 'is-large'],
    text: '温故而知新',
    rect: { x: 12, y: 34, w: 210, h: 28 },
    styles: {
      color: 'rgb(11, 11, 11)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      fontFamily: 'Inter, sans-serif',
      fontSize: '20px',
      fontWeight: '600',
      lineHeight: '25px',
      letterSpacing: 'normal',
      textAlign: 'start',
      padding: '0px',
      margin: '0px 0px 8px',
      borderRadius: '0px',
      display: 'block',
      width: '210px',
      height: '28px'
    },
    sourceOffset: 42,
    outerHtml: '<h2 id="title" class="headline is-large">温故而知新</h2>'
  }
  const decoded = bridge.readCanvasElementInfo(element)
  assert.deepEqual(decoded.rect, { x: 12, y: 34, w: 210, h: 28 }, '元素外框保留画框内 CSS 像素')
  assert.equal(decoded.selector, element.selector)
  assert.equal(decoded.tag, 'h2')
  assert.equal(decoded.id, 'title')
  assert.deepEqual(decoded.classes, ['headline', 'is-large'])
  assert.equal(decoded.text, element.text)
  assert.equal(decoded.styles.fontSize, '20px')
  assert.equal(decoded.styles.lineHeight, '25px')
  assert.equal(decoded.styles.borderRadius, '0px')
  assert.equal(decoded.sourceOffset, 42, 'data-yan-src 数值被保留')
  assert.equal(decoded.outerHtml, element.outerHtml)

  assert.equal(bridge.readCanvasElementInfo(null), null)
  assert.equal(bridge.readCanvasElementInfo('nope'), null)
  assert.equal(bridge.readCanvasElementInfo({ ...element, tag: '' }), null, '缺少标签不算元素')
  assert.equal(bridge.readCanvasElementInfo({ ...element, selector: '' }), null, '缺少选择器不算元素')
  assert.equal(bridge.readCanvasElementInfo({ ...element, rect: { x: 0, y: 0, w: 0 } }), null, '外框字段不全不算元素')
  assert.equal(bridge.readCanvasElementInfo({ ...element, rect: { x: 0, y: 0, w: Number.NaN, h: 10 } }), null, '外框必须是有限数值')
  assert.equal(bridge.readCanvasElementInfo({ ...element, rect: { x: 0, y: 0, w: '10', h: 10 } }), null, '外框不接受字符串')

  const clipped = bridge.readCanvasElementInfo({ ...element, text: 'x'.repeat(400), outerHtml: '<i>'.repeat(4000) })
  assert.equal(clipped.text.length, bridge.CANVAS_INFO_TEXT_MAX, '文字截到 200 字')
  assert.equal(clipped.outerHtml.length, bridge.CANVAS_INFO_HTML_MAX, 'HTML 截到 2000 字')
  assert.equal(clipped.path, '0.2.1', '路径原样保留')

  const sparse = bridge.readCanvasElementInfo({ tag: 'p', selector: 'p', rect: { x: 1, y: 2, w: 3, h: 4 }, classes: ['ok', 5, null], styles: { color: 12 } })
  assert.deepEqual(sparse.classes, ['ok'], '非字符串类名被丢弃')
  assert.equal(sparse.styles.color, '', '非字符串样式变成空串')
  assert.equal(sparse.styles.display, '', '缺少的样式补空串')
  assert.equal(sparse.id, '')
  assert.equal(sparse.text, '')
  assert.equal(sparse.outerHtml, '')
  assert.equal(sparse.sourceOffset, undefined, '没有 data-yan-src 就没有偏移')
  assert.equal(bridge.readCanvasElementInfo({ ...element, sourceOffset: -5 }).sourceOffset, 0, '负偏移归零')
  assert.equal(bridge.readCanvasElementInfo({ ...element, sourceOffset: '12' }).sourceOffset, undefined, '字符串偏移被忽略')

  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'ready' }), { kind: 'ready' })
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'hover', info: element }), { kind: 'hover', info: decoded }, '悬停事件带元素信息')
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'hover', info: null }), { kind: 'hover', info: null }, '离开元素时清空悬停')
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'select', info: element }), { kind: 'select', info: decoded }, '点选事件带元素信息')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'select', info: { tag: 'p' } }), null, '点选信息不完整就丢弃')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-preview': 'probe', id: 1 }), null, '预览频道消息不被当成画布事件')
  assert.equal(bridge.readCanvasBridgeEvent('ready'), null)
  assert.equal(bridge.readCanvasBridgeEvent(null), null)
  assert.equal('frameId' in decoded, false, '页面侧不回报画框 id，由父页面补')

  const nonce = 'a'.repeat(32)
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'ready', nonce }, nonce), { kind: 'ready' }, 'nonce 对上时接受消息')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'ready' }, nonce), null, '缺少 nonce 的消息被丢弃')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'ready', nonce: 'b'.repeat(32) }, nonce), null, 'nonce 不符的消息被丢弃')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'select', nonce, info: element }, ''), null, '不知道 nonce 时一律丢弃')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'hover', nonce, info: element }, nonce).kind, 'hover', '带 nonce 的悬停消息放行')
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'scroll', nonce }, nonce), { kind: 'scroll' }, '页面滚动回报单独识别')

  assert.deepEqual(
    bridge.readCanvasBridgeEvent({ 'yan-canvas': 'resolve-reply', nonce, id: 'r1', rect: { x: 1, y: 2, w: 3, h: 4 } }, nonce),
    { kind: 'resolve', id: 'r1', rect: { x: 1, y: 2, w: 3, h: 4 } },
    'resolve 回报带元素外框'
  )
  assert.deepEqual(
    bridge.readCanvasBridgeEvent({ 'yan-canvas': 'resolve-reply', nonce, id: 'r1', rect: null }, nonce),
    { kind: 'resolve', id: 'r1', rect: null },
    'resolve 没找到时回报 null'
  )
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'resolve-reply', nonce, id: '', rect: null }, nonce), null, '没有请求 id 的 resolve 回报被丢弃')
  assert.equal(
    bridge.readCanvasBridgeEvent({ 'yan-canvas': 'resolve-reply', nonce, id: 'r1', rect: { x: 1, y: 2, w: 3 } }, nonce).rect,
    null,
    '不完整的外框当作没找到'
  )
  assert.equal(
    bridge.readCanvasBridgeEvent({ 'yan-canvas': 'resolve-reply', nonce: 'c'.repeat(32), id: 'r1', rect: { x: 1, y: 2, w: 3, h: 4 } }, nonce),
    null,
    '伪造的 resolve 回报被丢弃'
  )
  assert.deepEqual(bridge.readCanvasElementRect({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 })
  assert.equal(bridge.readCanvasElementRect({ x: 1, y: 2, w: 3, h: Number.NaN }), null)
  assert.equal(bridge.readCanvasElementRect(null), null)
  assert.deepEqual(
    bridge.canvasResolveMessage('r7', { selector: 'h2.title', path: '0.1', text: '标题' }),
    { 'yan-canvas': 'resolve', id: 'r7', selector: 'h2.title', path: '0.1', text: '标题' },
    '定位请求带请求 id 与三级查找条件'
  )
  assert.deepEqual(
    bridge.canvasResolveMessage('r7', { selector: '', path: '0.1', text: '  ' }),
    { 'yan-canvas': 'resolve', id: 'r7', selector: '', path: '0.1' },
    '没有文字时不发文字条件'
  )

  const before = bridge.CANVAS_BRIDGE_PARTS.length
  bridge.registerCanvasBridgePart(';(function(){window.__yanExtra=1})();')
  bridge.registerCanvasBridgePart(';(function(){window.__yanExtra=1})();')
  assert.equal(bridge.CANVAS_BRIDGE_PARTS.length, before + 1, '追加片段去重')
  assert.ok(bridge.canvasBridgeRuntime().includes('window.__yanExtra=1'), '追加片段进入运行时并保持顺序')
  bridge.CANVAS_BRIDGE_PARTS.length = before

  const scoped = bridge.canvasBridgeRuntime(nonce)
  const scopedScript = scoped.slice(open.length, -'</script>'.length)
  assert.ok(scopedScript.startsWith('(function(){var self=document.currentScript;if(self&&self.parentNode)self.parentNode.removeChild(self);'), '桥接脚本执行时先把自己从 DOM 移除，页面读不到 nonce')
  assert.ok(scopedScript.includes(`var ${bridge.HTML_CANVAS_BRIDGE_SCOPE}={nonce:"${nonce}"};`), '一次性 nonce 写进注入脚本的闭包作用域')
  assert.ok(!scopedScript.includes('window.__yanCanvasBridge'), '不再向页面暴露带 post 能力的桥接对象')
  assert.ok(!scopedScript.includes('window.nonce') && !scopedScript.includes('data-nonce'), 'nonce 不挂在 window 或 DOM 属性上')
  assert.ok(scopedScript.split('message.nonce=YAN_CANVAS.nonce').length - 1 >= 3, '页面侧每条 post 都带 nonce')
  assert.ok(scopedScript.includes('resolve-reply'), '注入脚本含评论定位片段')
  assert.doesNotThrow(() => new Function(scopedScript), '带闭包 nonce 的脚本语法有效')

  const html = '<!doctype html><html><body><p>hi</p></body></html>'
  const injected = preview.withPreviewRuntime(html)
  assert.ok(injected.startsWith('<!doctype html>'), 'doctype 保持在最前')
  assert.ok(injected.includes('<script data-yan-preview>'), '预览运行时先注入')
  assert.ok(injected.includes(open), '画布桥接运行时也注入')
  assert.ok(injected.indexOf('<script data-yan-preview>') < injected.indexOf(open), '预览运行时在画布桥接之前')
  assert.match(injected, /<p data-yan-src="\d+">hi<\/p><\/body><\/html>$/, '原文档内容留在后面并带源码标记')
  assert.equal(injected.split('</script>').length - 1, 2, '两个运行时各一个 script')
  assert.ok(preview.withPreviewRuntime(html, nonce).includes(`{nonce:"${nonce}"}`), '快照 nonce 随页面注入')

  const bare = preview.withPreviewRuntime('<p>hi</p>')
  assert.ok(bare.startsWith('<style data-yan-preview>'), '没有 doctype 时运行时注入到最前')
  assert.ok(bare.includes(open))
  console.log('html canvas bridge: script / protocol / element info / runtime injection passed')
} finally {
  await rm(outdir, { recursive: true, force: true })
}
