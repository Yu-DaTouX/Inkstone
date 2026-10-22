import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outDir = '.tmp/canvas-narrow-dock/out'
await mkdir(outDir, { recursive: true })
const outfile = join(outDir, 'dock-model.mjs')
await build({
  entryPoints: ['src/renderer/src/features/preview/canvas-tools/dock-model.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

assert.equal(m.DOCK_GAP, 12, '停靠栏与画框之间留 12px')
assert.equal(m.DOCK_EDGE, 8, '气泡离画布边缘至少 8px')

assert.equal(m.dockPanelLimit(600), 300, '展开面板最多占画布高度一半')
assert.equal(m.dockPanelLimit(601), 301, '一半向上取整')
assert.equal(m.dockPanelLimit(0), 0, '没有高度就没有上限')
assert.equal(m.dockPanelLimit(-40), 0, '负高度当作没有画布')
assert.equal(m.dockPanelLimit(Number.NaN), 0, '非数字高度当作没有画布')

assert.equal(m.dockReserveHeight(600, { top: 400, height: 120 }), 212, '预留 = 面板底边距 + 面板高度 + 间距')
assert.equal(m.dockReserveHeight(600, { top: 400, height: 0 }), 0, '没有面板就不预留')
assert.equal(m.dockReserveHeight(600, { top: 400, height: Number.NaN }), 0, '非法高度不预留')
assert.equal(m.dockReserveHeight(600, { top: Number.NaN, height: 40 }), 52, '非法顶边按贴底处理')
assert.equal(m.dockReserveHeight(600, { top: 500, height: 40 }, 0), 100, '间距可配置')
assert.equal(m.dockReserveHeight(600, { top: 500, height: 40 }, -5), 100, '负间距按 0 计')
assert.equal(m.dockReserveHeight(0, { top: 0, height: 40 }), 0, '没有画布就不预留')
assert.equal(m.dockReserveHeight(600, { top: 40, height: 500 }), 372, '超出半高的面板只按半高预留')
assert.equal(m.dockReserveHeight(600, { top: 400, height: 120 }), m.dockBottomInset(600, { top: 400, height: 120 }) + m.DOCK_GAP, '预留比底部占用多一个间距')

assert.equal(m.dockBottomInset(600, { top: 400, height: 120 }), 200, '底部占用从面板顶边算到画布底')
assert.equal(m.dockBottomInset(600, { top: 400, height: 0 }), 0, '没有面板就不占底部')
assert.equal(m.dockBottomInset(0, { top: 0, height: 40 }), 0, '没有画布就不占底部')

const anchor = { left: 100, top: 100, width: 80, height: 40 }
const viewport = { width: 520, height: 800 }

const below = m.dockPopover({ anchor, size: { width: 216, height: 168 }, viewport })
assert.deepEqual(below, { left: 32, top: 150, width: 216, maxHeight: 168, side: 'below' }, '下方放得下就贴着元素下方弹出')

const flipped = m.dockPopover({ anchor: { ...anchor, top: 700 }, size: { width: 216, height: 168 }, viewport })
assert.equal(flipped.side, 'above', '下方放不下就翻到上方')
assert.equal(flipped.top, 522, '上方气泡在自己的高度处对齐元素上边')

const inset = m.dockPopover({ anchor: { ...anchor, top: 500 }, size: { width: 216, height: 168 }, viewport, bottomInset: 200 })
assert.equal(inset.side, 'above', '停靠栏占住底部时气泡翻到上方')
assert.equal(inset.top, 322, '气泡避开停靠栏')

const rightEdge = m.dockPopover({ anchor: { ...anchor, left: 480 }, size: { width: 216, height: 168 }, viewport })
assert.equal(rightEdge.left, 296, '右侧被画布边缘夹住')
assert.equal(rightEdge.width, 216, '夹取不改宽度')

const narrowViewport = m.dockPopover({ anchor, size: { width: 216, height: 168 }, viewport: { width: 120, height: 400 } })
assert.equal(narrowViewport.width, 104, '气泡宽度收进画布')
assert.equal(narrowViewport.left, 8, '收窄后从左边缘起')

const tight = m.dockPopover({ anchor: { left: 0, top: 120, width: 40, height: 40 }, size: { width: 200, height: 200 }, viewport: { width: 400, height: 300 } })
assert.equal(tight.top, 92, '上下都放不下时贴到底部可视区')
assert.equal(tight.maxHeight, 200, '压缩后高度仍在可视区内')
assert.ok(tight.top + tight.maxHeight <= 300 - 8, '气泡不越过画布下边缘')

const tightLimited = m.dockPopover({
  anchor: { left: 0, top: 120, width: 40, height: 40 },
  size: { width: 200, height: 200 },
  viewport: { width: 400, height: 200 }
})
assert.ok(tightLimited.top + tightLimited.maxHeight <= 200 - 8, '画布更矮时高度被截断')
assert.ok(tightLimited.maxHeight > 0, '截断后仍有可见高度')

const squashed = m.dockPopover({
  anchor: { left: 0, top: 0, width: 40, height: 40 },
  size: { width: 216, height: 168 },
  viewport: { width: 320, height: 400 },
  bottomInset: 360
})
assert.equal(squashed.maxHeight, 24, '底部被停靠栏占满时气泡只剩可见高度')
assert.ok(squashed.top >= 8, '气泡顶边不越界')

const fallback = m.dockPopover({ anchor, size: { width: 216, height: 168 }, viewport: { width: 0, height: 0 } })
assert.deepEqual(fallback, { left: 100, top: 150, width: 216, maxHeight: 168, side: 'below' }, '画布尺寸未知时退回锚点位置')

const hugeInset = m.dockPopover({ anchor, size: { width: 216, height: 168 }, viewport, bottomInset: 5000 })
assert.equal(hugeInset.side, 'above', '停靠栏高过画布时依然翻到上方')
assert.ok(hugeInset.top >= 8 && hugeInset.left >= 8, '坐标不做负数')

console.log('canvas-narrow-dock: ok')
