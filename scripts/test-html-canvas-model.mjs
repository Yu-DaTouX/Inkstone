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

  const layout = m.layoutFrames(m.CANVAS_VIEWPORTS)
  assert.deepEqual(layout.frames.map((f) => f.viewport.id), ['desktop', 'phone'])
  assert.equal(layout.frames[1].left, 1280 + m.CANVAS_FRAME_GAP, '卡片横向排列并留间距')
  assert.equal(layout.width, 1280 + 390 + m.CANVAS_FRAME_GAP)
  assert.equal(layout.height, 844 + m.CANVAS_HEADER, '高度取最高卡片加标题栏')

  const fit = m.fitView(1000, 700, layout.width, layout.height)
  assert.ok(fit.zoom > 0 && fit.zoom < 1, '内容比画布大时缩小')
  assert.ok(Math.abs(fit.x * 2 + layout.width * fit.zoom - 1000) < 1e-6, '适配后水平居中')
  assert.ok(layout.height * fit.zoom <= 700 - 96 + 1e-6 && layout.width * fit.zoom <= 1000 - 96 + 1e-6, '适配后留出边距')
  assert.equal(m.fitView(4000, 3000, 400, 300).zoom, 1, '内容小时不放大超过 100%')
  assert.deepEqual(m.fitView(0, 0, 10, 10), { x: 0, y: 0, zoom: 1 })

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
  console.log('html canvas model: layout / fit / zoom-at-point / pan / steps passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}
