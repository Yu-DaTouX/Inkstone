import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await runSuite(import.meta.url, async (ok, compile) => {
  const model = await compile(resolve(ROOT, 'src/renderer/src/features/ambient/usage-landscape-model.ts'))
  const { LANDSCAPE_DAYS, LANDSCAPE_LAYERS, LANDSCAPE_PAD, landscapeData, landscapeLayout, buildRidge, ridgeAt, peakX, dayAt, hoverDay, dayLabel, glyphInk, layerBase, ridgePresence, mainDay, farCenter, reflectionAlpha } = model

  const day = (index) => `2026-10-${String(index + 1).padStart(2, '0')}`
  const heat = Array.from({ length: 60 }, (_, i) => ({ date: day(i % 28), tokens: i === 59 ? 4000 : i === 50 ? 1000 : i === 40 ? 2000 : 0 }))
  const data = landscapeData(heat)
  ok(data.near.values.length === LANDSCAPE_DAYS && data.mid.values.length === LANDSCAPE_DAYS && data.far.values.length === LANDSCAPE_DAYS, '三个窗口各 14 天')
  ok(data.near.values[13] === 1, '全局峰值归一到 1', data.near.values[13])
  ok(data.near.values[4] > 0.25 && data.near.values[4] < 1, '小值经过压缩后仍看得见', data.near.values[4])
  ok(data.total === 5000, '合计只算最近 14 天', data.total)
  ok(data.mid.values[8] > 0 && data.far.tokens.every((value) => value === 0), '更早的用量落在中景，远景为空')

  const short = landscapeData([{ date: '2026-11-11', tokens: 10 }])
  ok(short.near.tokens[13] === 10 && short.near.dates[0] === '' && short.total === 10, '数据不足时在前面补零')
  ok(landscapeData([]).near.values.every((value) => value === 0), '没有数据时全零且不出现 NaN')

  const layout = landscapeLayout(1000, 1000, 100, 800)
  ok(layout.visible && layout.base === 696 && layout.rise === 380, '高度够时山高封顶', layout)
  ok(!landscapeLayout(1000, 300, 100, 220).visible, '空间太矮时不画')
  ok(!landscapeLayout(200, 800, 100, 600).visible, '太窄时不画')

  const near = LANDSCAPE_LAYERS[0]
  const ridge = buildRidge(layout, near, data.near.values)
  ok(ridge.length === 1000 + LANDSCAPE_PAD * 2, '山脊带左右余量')
  const today = ridgeAt(ridge, peakX(layout, 13))
  const quiet = ridgeAt(ridge, peakX(layout, 8))
  ok(today < quiet - 150, '用量高的一天峰更高', { today, quiet })
  ok([...ridge].every((y) => Number.isFinite(y) && y <= layerBase(layout, near) + 20), '山脊不掉到基线以下很多')
  ok(Math.abs(dayAt(layout, peakX(layout, 5)) - 5) < 1e-9, '日期与横坐标互逆')

  ok(hoverDay(layout, peakX(layout, 3) + 10, 300, 100) === 3, '悬停落到最近的一天')
  ok(hoverDay(layout, peakX(layout, 3), 40, 100) === -1 && hoverDay(layout, peakX(layout, 3), 790, 100) === -1, '天空以上和基线以下不触发')
  const mid = LANDSCAPE_LAYERS[1]
  const midRidge = buildRidge(layout, mid, data.mid.values)
  ok(ridgePresence(layout, mid, ridgeAt(midRidge, peakX(layout, 8) + (0.4 / 13) * (layout.right - layout.left))) === 1 && ridgePresence(layout, mid, ridgeAt(midRidge, peakX(layout, 1))) < 0.2, '中景没有用量的地方隐去，不留横线')
  ok(ridgePresence(layout, near, ridgeAt(ridge, peakX(layout, 8))) === 1, '近景始终落地')
  ok(hoverDay(layout, 5, 300, 100) === -1, '两侧留白不触发')

  ok(dayLabel('2026-11-09', '1.2M') === '11/9 · 1.2M' && dayLabel('', '0') === '0', '标注写月日与用量')
  ok(glyphInk(near, 0, 300, 1) > glyphInk(near, 80, 300, 1) && glyphInk(near, 80, 300, 1) > 0, '字符墨色沿山脊最浓并向下变淡')
  const far = LANDSCAPE_LAYERS[2]
  ok(glyphInk(far, 0, 300, 1) === 0 && glyphInk(mid, 4, 300, 1) > 0 && glyphInk(mid, 40, 300, 1) === 0, '远山不放字符，中景只勾山脊')
  ok(mainDay(data.near.values) === 13 && farCenter(layout, 13) < 500 && farCenter(layout, 2) > 500, '远山落在主峰的另一侧')
  const farRidge = buildRidge(layout, far, [], farCenter(layout, 13))
  ok(ridgePresence(layout, far, ridgeAt(farRidge, farCenter(layout, 13))) === 1 && ridgePresence(layout, far, ridgeAt(farRidge, 900)) === 0, '远山只占一侧，另一侧留白')
  ok(reflectionAlpha(0, 100) > reflectionAlpha(50, 100) && reflectionAlpha(100, 100) === 0 && reflectionAlpha(10, 0) === 0, '倒影越深越淡')
})
