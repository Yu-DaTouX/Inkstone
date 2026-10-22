#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  checks++
  console.log(`✓ ${label}`)
}

const captureCalls = []
const scopeCalls = []
let captureResult = { ok: true, data: 'aGVsbG8=', width: 200, height: 100, scaleFactor: 2 }
const listeners = new Map()
const added = []

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}
globalThis.window = {
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  dispatchEvent: (event) => {
    for (const fn of listeners.get(event.type) ?? []) fn(event)
    return true
  },
  yan: {
    canvas: {
      capture: async (rect, scope) => {
        captureCalls.push(rect)
        scopeCalls.push(scope)
        return captureResult
      }
    }
  }
}
globalThis.__canvasShareStore = {
  getState: () => ({ addAttachments: (items) => added.push(...items) })
}

const storeStub = {
  name: 'canvas-share-store-stub',
  setup(b) {
    b.onResolve({ filter: /state\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const useStore = globalThis.__canvasShareStore',
      loader: 'js'
    }))
  }
}

const electronStub = {
  name: 'canvas-capture-electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const BrowserWindow = {}', loader: 'js' }))
  }
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-canvas-share-'))
try {
  const captureFile = join(dir, 'canvas-capture-ipc.mjs')
  await build({
    entryPoints: ['src/main/ipc/canvas-capture-ipc.ts'],
    outfile: captureFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [electronStub]
  })
  const capture = await import(pathToFileURL(captureFile).href)

  const viewport = { width: 1200, height: 800 }
  assert.deepEqual(capture.clipCanvasRect({ x: 10, y: 20, width: 100, height: 50 }, viewport), { x: 10, y: 20, width: 100, height: 50 }, '窗口内矩形原样保留')
  assert.deepEqual(capture.clipCanvasRect({ x: -30, y: -40, width: 100, height: 90 }, viewport), { x: 0, y: 0, width: 70, height: 50 }, '越出左上角的矩形裁到窗口内')
  assert.deepEqual(capture.clipCanvasRect({ x: 1150, y: 780, width: 400, height: 300 }, viewport), { x: 1150, y: 780, width: 50, height: 20 }, '越出右下角的矩形裁到窗口内')
  assert.deepEqual(capture.clipCanvasRect({ x: 10.6, y: 20.2, width: 99.6, height: 49.4 }, viewport), { x: 10, y: 20, width: 101, height: 50 }, '小数矩形向外取整以保留像素')
  assert.equal(capture.clipCanvasRect({ x: 1200, y: 0, width: 100, height: 100 }, viewport), null, '完全在窗口外返回空')
  assert.equal(capture.clipCanvasRect({ x: 0, y: 0, width: 0, height: 100 }, viewport), null, '零宽矩形无效')
  assert.equal(capture.clipCanvasRect({ x: 0, y: 0, width: Number.NaN, height: 100 }, viewport), null, '非数字矩形无效')
  assert.equal(capture.clipCanvasRect(null, viewport), null, '缺参数返回空')
  assert.deepEqual(
    capture.clipCanvasRect({ x: 100, y: 100, width: 400, height: 400 }, viewport, { x: 0, y: 0, width: 300, height: 300 }),
    { x: 100, y: 100, width: 200, height: 200 },
    '超出画布可见区的部分先夹到 scope 内'
  )
  assert.deepEqual(
    capture.clipCanvasRect({ x: 0, y: 0, width: 2000, height: 2000 }, viewport, { x: 0, y: 0, width: 300, height: 300 }),
    { x: 0, y: 0, width: 300, height: 300 },
    '同时受 scope 与窗口约束时取更小的交集'
  )
  assert.equal(capture.clipCanvasRect({ x: 100, y: 100, width: 50, height: 50 }, viewport, { x: 500, y: 500, width: 100, height: 100 }), null, 'scope 交集为空返回 null')
  assert.deepEqual(
    capture.clipCanvasRect({ x: 10, y: 20, width: 100, height: 50 }, viewport, { x: Number.NaN, y: 0, width: 100, height: 100 }),
    { x: 10, y: 20, width: 100, height: 50 },
    '非法 scope 被忽略'
  )
  ok(true, '截图矩形裁剪')

  assert.deepEqual(capture.scaleCanvasRect({ x: 10, y: 10, width: 100, height: 100 }, 1.25), { x: 12, y: 12, width: 126, height: 126 }, 'CSS 像素按缩放换算成 DIP 并向外取整')
  assert.deepEqual(capture.scaleCanvasRect({ x: 10, y: 10, width: 100, height: 100 }, 2), { x: 20, y: 20, width: 200, height: 200 }, '两倍缩放是整倍换算')
  assert.deepEqual(capture.scaleCanvasRect({ x: 0, y: 0, width: 40, height: 20 }, 0), { x: 0, y: 0, width: 40, height: 20 }, '缩放为 0 时按 1 处理')
  assert.deepEqual(capture.scaleCanvasRect({ x: 0, y: 0, width: 3, height: 3 }, 0.5), { x: 0, y: 0, width: 2, height: 2 }, '小于 1 的缩放至少保留 1 像素')

  const css = capture.clipCanvasRect({ x: -10, y: -10, width: 200, height: 200 }, { width: 960, height: 640 })
  const dip = capture.scaleCanvasRect(css, 1.5)
  assert.deepEqual(css, { x: 0, y: 0, width: 190, height: 190 }, '先按 CSS 视口裁剪')
  assert.deepEqual(dip, { x: 0, y: 0, width: 285, height: 285 }, '再按缩放乘到 DIP')
  const device = { width: dip.width * 2, height: dip.height * 2 }
  assert.equal(device.width / dip.width, 2, '设备像素 = DIP × devicePixelRatio')
  ok(true, '缩放与 devicePixelRatio 换算')

  const shareFile = join(dir, 'canvas-share.mjs')
  await build({
    entryPoints: ['src/renderer/src/features/preview/canvas-share.ts'],
    outfile: shareFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [storeStub]
  })
  const share = await import(pathToFileURL(shareFile).href)

  const regionFile = join(dir, 'canvas-region.mjs')
  await build({
    entryPoints: ['src/renderer/src/features/preview/canvas-region.ts'],
    outfile: regionFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const region = await import(pathToFileURL(regionFile).href)

  const frameSize = { width: 1000, height: 800 }
  const stage = { x: 100, y: 50, w: 700, h: 600 }
  const box = { x: 150, y: 100, w: 500, h: 400 }
  assert.deepEqual(
    region.elementVisibleRegion(frameSize, box, stage, { x: 10, y: 20, w: 100, h: 50 }),
    { x: 10, y: 20, w: 100, h: 50 },
    '元素区域完全可见时原样保留'
  )
  assert.deepEqual(
    region.elementVisibleRegion(frameSize, { x: -150, y: 100, w: 500, h: 400 }, stage, { x: 480, y: 0, w: 100, h: 100 }),
    { x: 500, y: 0, w: 80, h: 100 },
    '画框被舞台左侧遮住时按可见像素裁剪'
  )
  assert.deepEqual(
    region.elementVisibleRegion(frameSize, box, { x: 150, y: 100, w: 200, h: 400 }, { x: 0, y: 0, w: 1000, h: 800 }),
    { x: 0, y: 0, w: 400, h: 800 },
    '元素超出画框可见部分时裁到窗口内'
  )
  assert.equal(
    region.elementVisibleRegion(frameSize, { x: -2000, y: -2000, w: 500, h: 400 }, stage, { x: 0, y: 0, w: 100, h: 100 }),
    null,
    '画框完全在舞台外时不给截图区域'
  )
  assert.equal(
    region.elementVisibleRegion(frameSize, box, stage, { x: 10, y: 900, w: 50, h: 50 }),
    null,
    '元素在画框内滚动出可视区时不给截图区域'
  )
  assert.equal(region.elementVisibleRegion(frameSize, { ...box, w: 0 }, stage, { x: 0, y: 0, w: 10, h: 10 }), null, '画框尺寸为 0 时放弃截图')
  assert.equal(region.elementVisibleRegion(frameSize, box, stage, { x: 10, y: 20, w: 0.5, h: 0.5 }), null, '小于一个像素的区域放弃截图')
  assert.deepEqual(region.visibleBoxRegion(frameSize, box, stage), { x: 0, y: 0, w: 1000, h: 800 }, '可见画框求交与标注工具一致')
  assert.deepEqual(region.rectClamp({ x: -10, y: -10, w: 40, h: 40 }, { x: 0, y: 0, w: 20, h: 20 }), { x: 0, y: 0, w: 20, h: 20 }, '矩形夹到边界内')
  assert.equal(region.rectIntersect({ x: 0, y: 0, w: 4, h: 4 }, { x: 8, y: 8, w: 4, h: 4 }), null, '不相交返回 null')
  ok(true, '元素可见区求交')

  const info = share.formatElementReference({
    path: 'preview/Card.html',
    selector: 'body > main > .card:nth-of-type(2)',
    tag: 'DIV',
    text: '  累计\n  收入     12,480 元  ',
    rect: { x: 120.4, y: 240.6, w: 320, h: 180 },
    outerHtml: '<div class="card" data-yan-src="1024">\n  <b data-yan-src="1050">收入</b>\n</div>',
    sourceOffset: 1024
  })
  const lines = info.split('\n')
  assert.ok(!info.includes('preview/Card.html'), 'DOM 路径不当作文件名')
  assert.ok(lines.includes('选择器：body > main > .card:nth-of-type(2)'), '带选择器')
  assert.ok(lines.includes('标签：div'), '标签统一小写')
  assert.ok(lines.includes('文字：累计 收入 12,480 元'), '文字压成一行')
  assert.ok(lines.some((line) => line.startsWith('尺寸：320×180，左上角 120,241')), '尺寸取整并标明坐标单位')
  assert.ok(lines.includes('源偏移：1024 字符'), '带源位置偏移')
  assert.ok(lines.includes('HTML：<div class="card"> <b>收入</b> </div>'), 'HTML 压成一行并去掉源码标记')
  assert.ok(info.split('\n').length >= 6 && /：/.test(info), '多行纯文本')

  const long = share.formatElementReference({
    path: 'a.html',
    selector: '#x',
    tag: 'p',
    text: 'x'.repeat(400),
    rect: { x: 0, y: 0, w: 10, h: 10 },
    outerHtml: '<p>' + 'y'.repeat(1000) + '</p>'
  })
  const longLines = long.split('\n')
  const textLine = longLines.find((line) => line.startsWith('文字：'))
  const htmlLine = longLines.find((line) => line.startsWith('HTML：'))
  assert.ok(textLine.length < 140 && textLine.endsWith('…'), '长文字截断')
  assert.ok(htmlLine.length < 420 && htmlLine.endsWith('…'), '长 HTML 截断')
  assert.equal(longLines.filter((line) => line.startsWith('源偏移：')).length, 0, '没有偏移时不写该行')
  const bare = share.formatElementReference({ path: '', selector: '', tag: '', rect: { x: 0, y: 0, w: 0, h: 0 } })
  assert.equal(bare.split('\n').filter((line) => line.startsWith('文字：') || line.startsWith('HTML：')).length, 0, '缺字段时不写空行')
  ok(true, '元素引用文本')

  const element = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 200 }) }
  const shot = await share.captureElementRegion(element, { x: 5, y: 6, w: 100, h: 50 })
  assert.deepEqual(captureCalls.at(-1), { x: 15, y: 26, width: 100, height: 50 }, '元素位置加内部子矩形偏移后交给主进程')
  assert.equal(shot.kind, 'image', '截图附件是图片')
  assert.equal(shot.mimeType, 'image/png', 'MIME 为 PNG')
  assert.equal(shot.data, 'aGVsbG8=', 'data 是 PNG base64')
  assert.equal(shot.preview, shot.data, 'preview 复用同一份 base64')
  assert.equal(shot.size, 5, '附件字节数按 base64 长度换算')
  assert.ok(/^canvas-.*\.png$/.test(shot.name), '附件名带时间戳避免去重')

  const full = await share.captureElementRegion(element)
  assert.deepEqual(captureCalls.at(-1), { x: 10, y: 20, width: 300, height: 200 }, '不给子矩形时截整个元素')
  assert.equal(scopeCalls.at(-1), undefined, '不给可见区时不传 scope')

  const scoped = await share.captureElementRegion(element, { x: 5, y: 6, w: 100, h: 50 }, undefined, { x: 0, y: 0, w: 640, h: 480 })
  assert.deepEqual(scopeCalls.at(-1), { x: 0, y: 0, width: 640, height: 480 }, '画布可见区换算成 scope 交给主进程')
  assert.deepEqual(captureCalls.at(-1), { x: 15, y: 26, width: 100, height: 50 }, '带 scope 时请求区域不变，由主进程夹取')
  assert.equal(scoped.kind, 'image')

  captureResult = { ok: false, error: '截图为空，请确认区域在可见窗口内' }
  await assert.rejects(() => share.captureElementRegion(element), /截图为空/, '主进程报错时抛出明确信息')
  captureResult = { ok: true, data: 'aGVsbG8=', width: 200, height: 100, scaleFactor: 2 }
  ok(true, '区域截图接线')

  assert.equal(share.sendToChat({ text: '看图' }), false, '没有输入框监听时返回 false')
  assert.equal(added.length, 0, '未送达时不加附件')

  const texts = []
  const listener = (event) => {
    if (event.detail.text) texts.push(event.detail.text)
    event.detail.handled = true
  }
  window.addEventListener(share.CANVAS_SEND_TO_CHAT_EVENT, listener)
  assert.equal(share.sendToChat({ text: '  这个卡片偏色  ', images: [shot] }), true, '有输入框监听时返回 true')
  assert.deepEqual(texts, ['这个卡片偏色'], '文本去空白后交给输入框')
  assert.deepEqual(added.map((item) => item.name), [shot.name], '图片附件进 store')
  window.removeEventListener(share.CANVAS_SEND_TO_CHAT_EVENT, listener)
  ok(true, '发送到聊天')

  console.log(`\n${checks} 项检查通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
