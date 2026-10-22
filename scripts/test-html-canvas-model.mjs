import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-html-canvas-'))
try {
  const outfile = join(dir, 'model.mjs')
  await build({ entryPoints: ['src/renderer/src/features/preview/html-canvas-model.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const m = await import(pathToFileURL(outfile).href)

  const presets = Object.fromEntries(m.CANVAS_DEVICE_PRESETS.map((viewport) => [viewport.id, `${viewport.width}x${viewport.height}`]))
  assert.deepEqual(presets, { desktop: '1440x900', laptop: '1280x800', tablet: '834x1194', phone: '390x844' }, '设备预设尺寸固定')
  assert.deepEqual(m.CANVAS_DEVICE_ORDER, ['desktop', 'laptop', 'tablet', 'phone', 'custom'], '设备顺序稳定')

  assert.deepEqual(m.viewportFor('tablet', 1000), { id: 'tablet', width: 834, height: 1194 })
  assert.deepEqual(m.viewportFor('custom', 1100), { id: 'custom', width: 1100, height: m.CANVAS_CUSTOM_DEVICE.height }, '自定义宽度按输入生效')
  assert.equal(m.viewportFor('custom', 10).width, m.CANVAS_CUSTOM_DEVICE.minWidth, '自定义宽度有下限')
  assert.equal(m.viewportFor('custom', 99999).width, m.CANVAS_CUSTOM_DEVICE.maxWidth, '自定义宽度有上限')
  assert.equal(m.viewportFor('custom', Number.NaN).width, m.CANVAS_CUSTOM_DEVICE.width, '非法宽度回到默认值')

  const state = m.parseCanvasFrameState(null)
  assert.deepEqual(state, { devices: ['desktop', 'phone'], customWidth: m.CANVAS_CUSTOM_DEVICE.width }, '没有记录时用默认画框')
  assert.deepEqual(m.visibleViewports(state).map((viewport) => viewport.id), ['desktop', 'phone'])
  assert.deepEqual(
    m.parseCanvasFrameState(JSON.stringify({ devices: ['phone', 'desktop', 'phone', 'nope'], customWidth: 5000 })),
    { devices: ['desktop', 'phone'], customWidth: m.CANVAS_CUSTOM_DEVICE.maxWidth },
    '记录去重、按固定顺序排列并夹紧宽度'
  )
  assert.deepEqual(m.parseCanvasFrameState('{oops'), m.parseCanvasFrameState(null), '坏记录回退到默认值')
  assert.deepEqual(m.parseCanvasFrameState(JSON.stringify({ devices: [] })).devices, ['desktop', 'phone'], '空选择回退到默认值')
  assert.deepEqual(m.parseCanvasFrameState(JSON.stringify({ devices: ['nope'] })).devices, ['desktop', 'phone'], '未知设备被丢弃')

  const onlyPhone = m.parseCanvasFrameState(JSON.stringify({ devices: ['phone'] }))
  assert.deepEqual(m.toggleCanvasDevice(onlyPhone, 'phone'), onlyPhone, '至少保留一个画框')
  const withTablet = m.toggleCanvasDevice(onlyPhone, 'tablet')
  assert.deepEqual(withTablet.devices, ['tablet', 'phone'], '新勾选的画框按固定顺序插入')
  assert.deepEqual(m.toggleCanvasDevice(withTablet, 'tablet').devices, ['phone'], '取消勾选移除画框')
  assert.deepEqual(m.setCanvasDevices(onlyPhone, ['phone', 'laptop', 'desktop']).devices, ['desktop', 'laptop', 'phone'], '整组选择按固定顺序排列')
  assert.deepEqual(m.setCanvasDevices(onlyPhone, []), onlyPhone, '整组选择为空时不生效')
  assert.deepEqual(m.setCanvasCustomWidth(onlyPhone, 800).customWidth, 800)
  const roundTrip = m.parseCanvasFrameState(m.serializeCanvasFrameState(withTablet))
  assert.deepEqual(roundTrip, withTablet, '选择可序列化后原样读回')

  const layout = m.layoutFrames(m.visibleViewports(withTablet))
  assert.deepEqual(layout.frames.map((frame) => frame.viewport.id), ['tablet', 'phone'])
  assert.equal(layout.frames[1].left, 834 + m.CANVAS_FRAME_GAP, '卡片横向排列并留间距')
  assert.equal(layout.width, 834 + 390 + m.CANVAS_FRAME_GAP)
  assert.equal(layout.height, 1194 + m.CANVAS_HEADER, '高度取最高卡片加标题栏')

  const compositionLayout = m.layoutFrames(m.visibleViewports(withTablet, { width: 1920, height: 1080 }))
  assert.deepEqual(
    compositionLayout.frames.map((frame) => frame.viewport.id),
    ['composition'],
    '合成成果只显示一个合成画框'
  )
  assert.equal(compositionLayout.frames[0].viewport.width, 1920, '合成画框用页面画幅的宽度')
  assert.equal(compositionLayout.width, 1920)
  assert.equal(compositionLayout.height, 1080 + m.CANVAS_HEADER)
  assert.deepEqual(m.compositionViewport({ width: 1080, height: 1920 }), {
    id: 'composition',
    width: 1080,
    height: 1920
  }, '竖屏合成画幅')
  assert.equal(m.compositionViewport(null), null, '没有合成状态时不造画框')
  assert.deepEqual(m.visibleViewports(withTablet, null).map((viewport) => viewport.id), ['tablet', 'phone'], '退出合成后回到网页设备')

  const fit = m.fitView(1000, 700, layout.width, layout.height)
  assert.ok(fit.zoom > 0 && fit.zoom < 1, '内容比画布大时缩小')
  assert.ok(Math.abs(fit.x * 2 + layout.width * fit.zoom - 1000) < 1e-6, '适配后水平居中')
  assert.ok(layout.height * fit.zoom <= 700 - 96 + 1e-6 && layout.width * fit.zoom <= 1000 - 96 + 1e-6, '适配后留出边距')
  assert.equal(m.fitView(4000, 3000, 400, 300).zoom, 1, '内容小时不放大超过 100%')
  assert.deepEqual(m.fitView(0, 0, 10, 10), { x: 0, y: 0, zoom: 1 })

  const second = layout.frames[1]
  const focused = m.frameFocusView(second, 1200, 900, 32, m.CANVAS_HEAD_CHROME)
  const placedLeft = focused.x + second.left * focused.zoom
  const placedTop = focused.y + second.top * focused.zoom - m.CANVAS_HEAD_CHROME
  assert.ok(placedLeft >= 0 && placedLeft + second.viewport.width * focused.zoom <= 1200 + 1e-6, '缩放到画框后完整落在画布宽度内')
  assert.ok(placedTop >= 0 && placedTop + m.CANVAS_HEAD_CHROME + second.viewport.height * focused.zoom <= 900 + 1e-6, '缩放到画框后连同标题栏完整落在画布高度内')
  assert.ok(Math.abs(placedLeft + (second.viewport.width * focused.zoom) / 2 - 600) < 1e-6, '画框水平居中')
  const tall = m.frameFocusView(layout.frames[0], 4000, 4000)
  assert.equal(tall.zoom, 1, '空间足够时缩放到画框不放大超过 100%')

  const view = { x: 100, y: 50, zoom: 0.5 }
  const zoomed = m.zoomAt(view, 1, 300, 250)
  const before = { x: (300 - view.x) / view.zoom, y: (250 - view.y) / view.zoom }
  const after = { x: (300 - zoomed.x) / zoomed.zoom, y: (250 - zoomed.y) / zoomed.zoom }
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9, '光标下的内容点在缩放前后不动')
  assert.equal(m.zoomAt(view, 99, 0, 0).zoom, m.CANVAS_MAX_ZOOM, '缩放有上限')
  assert.equal(m.zoomAt(view, 0.001, 0, 0).zoom, m.CANVAS_MIN_ZOOM, '缩放有下限')
  assert.equal(m.clampZoom(Number.NaN), 1)

  assert.deepEqual(m.panBy(view, 10, -5), { x: 110, y: 45, zoom: 0.5 })
  assert.ok(m.wheelZoomFactor(-100) > 1 && m.wheelZoomFactor(100) < 1, '滚轮向上放大、向下缩小')
  assert.ok(m.wheelZoomFactor(-1e6) <= Math.exp(0.5) + 1e-9, '单次滚轮缩放有限幅')
  assert.equal(m.zoomStep(0.5, 1), 0.67)
  assert.equal(m.zoomStep(0.5, -1), 0.33)
  assert.equal(m.zoomStep(0.48, 1), 0.5, '非整档缩放按方向取最近档')
  assert.equal(m.zoomStep(2, 1), m.CANVAS_MAX_ZOOM)

  const stage = m.stageRect(second, { x: 10, y: 20, zoom: 0.5 }, { x: 40, y: 30, w: 200, h: 100 })
  assert.deepEqual(stage, { left: 10 + (second.left + 40) * 0.5, top: 20 + (second.top + 30) * 0.5, width: 100, height: 50 }, '元素外框随画布缩放换算到画布坐标')
  console.log('html canvas model: devices / frames / fit / focus / zoom-at-point / pan / steps passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}
