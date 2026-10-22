import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outDir = '.tmp/canvas-w2-涂画标注'
await mkdir(outDir, { recursive: true })
const modelOut = join(outDir, 'draw-model.mjs')
const textOut = join(outDir, 'draw-text.mjs')
await build({
  entryPoints: ['src/renderer/src/features/preview/canvas-tools/draw-model.ts'],
  outfile: modelOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
await build({
  entryPoints: ['src/renderer/src/features/preview/canvas-tools/draw-text.ts'],
  outfile: textOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const m = await import(pathToFileURL(modelOut).href)
const t = await import(pathToFileURL(textOut).href)

assert.deepEqual(m.DRAW_PENS, ['free', 'rect', 'ellipse', 'arrow', 'text'], '笔形顺序稳定')
assert.equal(m.DRAW_PALETTE.length, 5, '五个标注颜色')
assert.deepEqual(m.DRAW_PALETTE.map((spec) => spec.key), ['accent', 'fail', 'ok', 'ask', 'stall'], '颜色来自强调色与语义色变量')

assert.deepEqual(m.rectFromPoints({ x: 5, y: 9 }, { x: 1, y: 2 }), { x: 1, y: 2, w: 4, h: 7 }, '两点围出矩形')
assert.deepEqual(m.rectNormalize({ x: 10, y: 10, w: -4, h: -6 }), { x: 6, y: 4, w: 4, h: 6 }, '负宽高归一化')
assert.deepEqual(m.rectUnion({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 0, y: 0, w: 15, h: 15 }, '外接矩形并集')
assert.deepEqual(m.rectIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 })
assert.equal(m.rectIntersect({ x: 0, y: 0, w: 4, h: 4 }, { x: 8, y: 8, w: 4, h: 4 }), null, '不相交返回 null')
assert.deepEqual(m.rectExpand({ x: 2, y: 2, w: 4, h: 4 }, 3), { x: -1, y: -1, w: 10, h: 10 }, '加边距')
assert.deepEqual(m.rectClamp({ x: -20, y: -5, w: 80, h: 40 }, { x: 0, y: 0, w: 50, h: 30 }), { x: 0, y: 0, w: 50, h: 30 }, '裁到画框内')
assert.deepEqual(m.rectClamp({ x: 40, y: 10, w: 30, h: 5 }, { x: 0, y: 0, w: 50, h: 30 }), { x: 40, y: 10, w: 10, h: 5 }, '右边界裁切')
assert.ok(m.rectIsTiny({ x: 0, y: 0, w: 1, h: 20 }), '过窄的形状算微小')
assert.ok(!m.rectIsTiny({ x: 0, y: 0, w: 20, h: 20 }))
assert.equal(m.distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)

const line = []
for (let i = 0; i <= 20; i++) line.push({ x: i * 5, y: 0 })
assert.deepEqual(m.simplifyPoints(line, 0.75), [{ x: 0, y: 0 }, { x: 100, y: 0 }], '直线上的中间点被简化掉')
const spike = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 20, y: 20 },
  { x: 30, y: 0 },
  { x: 40, y: 0 }
]
assert.equal(m.simplifyPoints(spike, 0.75).length, 5, '超出容差的拐点保留')
assert.equal(m.simplifyPoints(spike, 10).length, 3, '容差放大后丢掉小折点')
assert.deepEqual(m.simplifyPoints([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }], 1), [{ x: 1, y: 1 }, { x: 2, y: 2 }], '重复点被去掉')
assert.deepEqual(m.simplifyPoints([{ x: 0, y: 0 }], 1), [{ x: 0, y: 0 }])

assert.equal(m.strokePath([]), '', '空点列没有路径')
assert.match(m.strokePath([{ x: 2, y: 3 }]), /^M 2 3 l 0\.01 0$/, '单点画成小点')
assert.equal(m.strokePath([{ x: 0, y: 0 }, { x: 4, y: 4 }]), 'M 0 0 L 4 4')
const smooth = m.strokePath([
  { x: 0, y: 0 },
  { x: 10, y: 20 },
  { x: 30, y: 10 },
  { x: 40, y: 40 }
])
assert.equal((smooth.match(/C /g) ?? []).length, 3, '多点用三次贝塞尔平滑')
assert.ok(!smooth.includes('NaN'), '路径里没有非法数字')

const arrow = m.arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 3, 1)
assert.deepEqual(arrow.head[0], { x: 100, y: 0 }, '箭头顶点落在终点')
assert.equal(arrow.head.length, 3)
assert.ok(arrow.line[1].x < 100 && arrow.line[1].x > 80, '箭杆在箭头底座前结束')
const tiny = m.arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 3, 1)
assert.equal(tiny.head.length, 0, '零长度箭头只留箭杆')
const scaled = m.arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 3, 4)
assert.ok(Math.hypot(scaled.head[1].x - 100, scaled.head[1].y) > Math.hypot(arrow.head[1].x - 100, arrow.head[1].y), '箭头随线宽单位放大')

assert.deepEqual(m.textLines('  第一行\n第二行  \n\n'), ['第一行', '第二行'], '去掉首尾空行并修剪空白')
assert.deepEqual(m.textLines('a\n\nb'), ['a', '', 'b'], '中间空行保留')
assert.deepEqual(m.textLines('   '), [])
assert.ok(m.estimateTextWidth('中文', 15) > m.estimateTextWidth('ab', 15), '中日韩字符更宽')

const strokeShape = { kind: 'free', points: line, color: '#2A78D6', width: 3 }
assert.deepEqual(m.shapeBounds(strokeShape), { x: 0, y: 0, w: 100, h: 0 })
assert.deepEqual(m.shapeBounds({ kind: 'arrow', from: { x: 10, y: 40 }, to: { x: 5, y: 10 }, color: '#f00', width: 3 }), { x: 5, y: 10, w: 5, h: 30 })
const labelShape = { kind: 'text', at: { x: 10, y: 20 }, text: '标题\n第二行', color: '#f00', halo: '#fff', size: 15 }
const labelBounds = m.shapeBounds(labelShape)
assert.equal(labelBounds.x, 10)
assert.equal(labelBounds.y, 20)
assert.ok(labelBounds.w > 0)
assert.ok(Math.abs(labelBounds.h - 2 * 15 * m.DRAW_TEXT_LINE) < 1e-9, '文字高度按行数计算')
assert.deepEqual(m.shapesBounds([]), null)
assert.deepEqual(
  m.shapesBounds([{ kind: 'rect', rect: { x: 0, y: 0, w: 10, h: 10 }, color: '#000', width: 3 }, { kind: 'ellipse', rect: { x: 20, y: 30, w: 5, h: 5 }, color: '#000', width: 3 }]),
  { x: 0, y: 0, w: 25, h: 35 },
  '多个形状取并集'
)
assert.deepEqual(m.shapeTextLabels([labelShape, strokeShape, { kind: 'text', at: { x: 0, y: 0 }, text: '  ', color: '#000', halo: '#fff', size: 15 }]), ['标题 第二行'], '文字标签列表忽略画笔与空白')

const freeSvg = m.shapeSvg(strokeShape, { unit: 4 })
assert.ok(freeSvg.includes('stroke-width="12"'), '线宽按单位换算')
assert.ok(freeSvg.includes('stroke-linecap="round"'))
assert.ok(freeSvg.startsWith('<path'))
assert.equal(m.shapeSvg({ kind: 'free', points: [], color: '#000', width: 3 }, { unit: 1 }), '', '空画笔没有输出')
const rectSvg = m.shapeSvg({ kind: 'rect', rect: { x: 0, y: 0, w: -10, h: -20 }, color: '#123456', width: 3 }, { unit: 1 })
assert.ok(rectSvg.includes('width="10"') && rectSvg.includes('height="20"'), '负宽高矩形按正数输出')
assert.ok(rectSvg.includes('fill="none"') && rectSvg.includes('stroke="#123456"'))
const ellipseSvg = m.shapeSvg({ kind: 'ellipse', rect: { x: 10, y: 10, w: 40, h: 20 }, color: '#f00', width: 3 }, { unit: 1 })
assert.ok(ellipseSvg.includes('cx="30"') && ellipseSvg.includes('cy="20"') && ellipseSvg.includes('rx="20"') && ellipseSvg.includes('ry="10"'))
const arrowSvg = m.shapeSvg({ kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, color: '#f00', width: 3 }, { unit: 1 })
assert.ok(arrowSvg.includes('<polygon') && arrowSvg.includes('fill="#f00"'), '箭头有实心三角')
const textSvg = m.shapeSvg({ kind: 'text', at: { x: 5, y: 5 }, text: 'a <b> & "c"\n第二行', color: '#f00', halo: '#fff', size: 30 }, { unit: 2 })
assert.ok(textSvg.includes('&lt;b&gt;'), '文字被转义')
assert.ok(!textSvg.includes('<b>'), '不输出原始标签')
assert.ok(textSvg.includes('&amp;') && textSvg.includes('&quot;c&quot;'))
assert.equal((textSvg.match(/<text /g) ?? []).length, 2, '每行一个 text')
assert.ok(textSvg.includes('font-size="30"'), '字号已按画框像素存储，不再二次缩放')
assert.ok(textSvg.includes('stroke-width="6"'), '文字光晕按屏幕线宽换算')
assert.ok(textSvg.includes('paint-order="stroke"'), '文字带描边光晕')

const svg = m.exportSvg([strokeShape, labelShape], { x: 4, y: 6, w: 120, h: 80 }, 2)
assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), '导出带命名空间')
assert.ok(svg.includes('viewBox="4 6 120 80"'), '导出 viewBox 对应截图区域')
assert.ok(svg.includes('preserveAspectRatio="none"'))
assert.ok(svg.includes('stroke-width="6"'), '导出线宽按截图比例换算')

const colors = m.resolveDrawColors((variable) => {
  if (variable === '--accent') return '#123456'
  if (variable === '--fail') return 'rgb(208, 59, 59)'
  if (variable === '--bg') return '#FFFFFF'
  return null
})
assert.equal(colors.accent, '#123456', '读取计算出的强调色')
assert.equal(colors.fail, 'rgb(208, 59, 59)', '读取计算出的语义色')
assert.equal(colors.ok, '#009300', '内联失败回退到常量')
assert.equal(colors.halo, '#FFFFFF')
const themed = m.resolveDrawColors((variable) => (variable === '--fail' ? 'light-dark(#D03B3B, #EC7E7E)' : null))
assert.equal(themed.fail, '#D03B3B', '未解析的 light-dark 值回退')
assert.ok(m.isCssColor('#abc') && m.isCssColor('rgba(0,0,0,.4)') && m.isCssColor('red'))
assert.ok(!m.isCssColor('light-dark(#fff, #000)') && !m.isCssColor('') && !m.isCssColor(null))
assert.equal(m.drawColor('nope', colors), colors.accent, '未知颜色键回到强调色')

const frame = { width: 1440, height: 900 }
const whole = m.visibleBoxRegion(frame, { x: 100, y: 60, w: 720, h: 450 }, { x: 0, y: 0, w: 1200, h: 800 })
assert.deepEqual(whole, { x: 0, y: 0, w: 1440, h: 900 }, '画框完全可见时可见区域是整框')
const clippedRegion = m.visibleBoxRegion(frame, { x: -200, y: 60, w: 1440, h: 900 }, { x: 0, y: 0, w: 1000, h: 800 })
assert.deepEqual(clippedRegion, { x: 200, y: 0, w: 1000, h: 740 }, '平移后可见区域按画布裁切')
const offstage = m.visibleBoxRegion(frame, { x: -2000, y: 0, w: 720, h: 450 }, { x: 0, y: 0, w: 800, h: 600 })
assert.deepEqual(offstage, { x: 0, y: 0, w: 120, h: 120 }, '画框完全移出时给出小区域')

const region = m.captureRegion([labelShape], whole, frame, 16)
assert.deepEqual(region, { x: 0, y: 0, w: 1440, h: 900 }, '标注在可见范围内时截图取整个可见画框')
const merged = m.captureRegion(
  [{ kind: 'rect', rect: { x: 1200, y: 700, w: 100, h: 100 }, color: '#000', width: 3 }],
  { x: 600, y: 0, w: 800, h: 560 },
  frame,
  16
)
assert.deepEqual(merged, { x: 600, y: 0, w: 800, h: 816 }, '标注与可见区域的并集，标注侧加边距')
const pinned = m.captureRegion(
  [{ kind: 'rect', rect: { x: 1400, y: 880, w: 100, h: 100 }, color: '#000', width: 3 }],
  { x: 0, y: 0, w: 200, h: 200 },
  frame,
  16
)
assert.deepEqual(pinned, { x: 0, y: 0, w: 1440, h: 900 }, '截图区域裁到画框内')

const zh = t.drawText('zh-CN')
const en = t.drawText('en-US')
assert.equal(zh.lang, 'zh-CN')
assert.equal(en.lang, 'en-US')
assert.equal(zh.title, '标注')
assert.equal(en.title, 'Annotate')
assert.equal(zh.pens.text, '文字')
assert.equal(en.pens.text, 'Text')
assert.equal(
  zh.prompt({ name: 'index.html', frame: '桌面', width: 1440, height: 900, texts: ['按钮太挤', '标题更大'] }),
  '请按截图里的标注修改 index.html（桌面 1440×900）：\n- 按钮太挤\n- 标题更大',
  '中文提示词与文字标签列表'
)
assert.equal(zh.prompt({ name: 'a.html', frame: '手机', width: 390, height: 844, texts: [] }), '请按截图里的标注修改 a.html（手机 390×844）：', '没有文字标签时不列项目')
assert.equal(
  en.prompt({ name: 'index.html', frame: 'Desktop', width: 1440, height: 900, texts: ['Button is cramped'] }),
  'Please revise index.html following the annotations in the screenshot (Desktop 1440×900):\n- Button is cramped'
)
assert.equal(zh.count(3), '3 处标注')
assert.equal(en.count(1), '1 annotation')
assert.equal(en.count(3), '3 annotations')

console.log('canvas draw model: geometry / simplify / path / arrow / bounds / svg / colors / capture region / prompt passed')
