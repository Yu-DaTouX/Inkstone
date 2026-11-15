import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { foldBrief, BRIEF_FOLD_CHARS, BRIEF_FOLD_LINES } = await compile('src/renderer/src/features/session/subagent-brief-fold.ts', { platform: 'neutral' })

  ok(foldBrief('查一下这两个模块') === null, '短任务不折叠')
  ok(foldBrief('x'.repeat(BRIEF_FOLD_CHARS)) === null, '正好到字数上限不折叠')
  ok(foldBrief(`${'行\n'.repeat(BRIEF_FOLD_LINES)}  \n`) === null, '后面只剩空白时不折叠')

  const long = '很长的任务说明。'.repeat(5000)
  const folded = foldBrief(long)
  ok(!!folded && folded.preview.length <= BRIEF_FOLD_CHARS && long.startsWith(folded.preview), '超长单行按字数折叠，预览是原文开头')
  ok(folded.total === [...long].length, '展开按钮报出完整字数')

  const manyLines = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 条`).join('\n')
  const byLines = foldBrief(manyLines)
  ok(!!byLines && byLines.preview.split('\n').length === BRIEF_FOLD_LINES && byLines.preview.endsWith(`第 ${BRIEF_FOLD_LINES} 条`), '行数过多时按行折叠，保留完整的前几行')

  const emoji = `${'a'.repeat(BRIEF_FOLD_CHARS - 1)}🖋️${'b'.repeat(50)}`
  const cut = foldBrief(emoji)
  ok(!!cut && !/[\uD800-\uDBFF]$/.test(cut.preview), '折叠位置不会切开代理对')
})
