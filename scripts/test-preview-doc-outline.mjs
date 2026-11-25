import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const outline = await compile('src/renderer/src/features/preview/doc-outline.ts')

  const heads = outline.outlineHeadings([
    { level: 2, text: '  数据与权限 ' },
    { level: 3, text: '本地\n存储' },
    { level: 2, text: '   ' },
    { level: 6, text: '很深' }
  ])
  ok(heads.length === 3, '空白标题被丢弃', JSON.stringify(heads))
  ok(heads[0].depth === 0 && heads[1].depth === 1, '层级相对最浅标题计算')
  ok(heads[1].text === '本地 存储', '标题内换行折成空格')
  ok(heads[2].depth === outline.OUTLINE_MAX_DEPTH, '层级封顶')
  ok(outline.outlineHeadings([]).length === 0, '没有标题时为空')

  ok(outline.activeHeading([], 10, false) === -1, '无标题时没有当前项')
  ok(outline.activeHeading([200, 400, 600], 10, false) === 0, '还没读到第一个标题时取第一项')
  ok(outline.activeHeading([0, 300, 700], 300, false) === 1, '标题刚好在阅读线上算当前')
  ok(outline.activeHeading([0, 300, 700], 699, false) === 1, '阅读线在两个标题之间取上一个')
  ok(outline.activeHeading([0, 300, 700], 100, true) === 2, '滚到底时取最后一项')

  const quiet = outline.hoverRail(100, 40, false, 1, 3)
  ok(!quiet.visible, '指针不在目录里时不画预览线')
  ok(!outline.hoverRail(100, 100, true, 2, 2).visible, '悬停当前项时不画预览线')
  const above = outline.hoverRail(100, 40, true, 1, 3)
  ok(above.visible && above.from === 34 && above.y === 40, '悬停在当前项上方只画转角')
  const below = outline.hoverRail(100, 180, true, 5, 3)
  ok(below.visible && below.from === 100 && below.y === 180, '悬停在当前项下方从当前项接着画')
  ok(outline.tickWidth(0) > outline.tickWidth(2) && outline.tickWidth(9) >= 6, '层级越深刻度越短且有下限')
})
