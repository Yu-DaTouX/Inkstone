export async function runKeepRunningTests(report) {
  const ok = (label, cond) => report(!!cond, label)
  const m = await import('../out/test/keep-running.mjs')
  const MARK = m.KEEP_RUNNING_DONE_MARK
  const turn = (extra = {}) => ({ error: false, toolCalls: 3, lastText: '阶段 1 做了一半', ...extra })

  ok('正常结束且调用过工具 → 继续', m.decideKeepRunning(turn(), 0).next === 'continue')
  ok('最后一行是完成标记 → 停（完成）', m.decideKeepRunning(turn({ lastText: `全部做完了\n\n${MARK}` }), 3).reason === 'done')
  ok('正文中间提到标记不算完成', m.decideKeepRunning(turn({ lastText: `做完后我会写「${MARK}」\n现在继续阶段 2` }), 0).next === 'continue')
  ok('完成标记优先于空转判定', m.decideKeepRunning(turn({ toolCalls: 0, lastText: MARK }), 0).reason === 'done')
  ok('错误结束 → 不发继续、保持开启', m.decideKeepRunning(turn({ error: true }), 0).next === 'skip')
  ok('本轮没有工具调用 → 停（空转）', m.decideKeepRunning(turn({ toolCalls: 0 }), 0).reason === 'idle')
  ok('达到上限 → 停', m.decideKeepRunning(turn(), m.KEEP_RUNNING_MAX).reason === 'limit')
  ok('上限前一次仍继续', m.decideKeepRunning(turn(), m.KEEP_RUNNING_MAX - 1).next === 'continue')
  ok('继续消息要求先读进度、完成只回标记', m.KEEP_RUNNING_PROMPT.includes('账本') && m.KEEP_RUNNING_PROMPT.includes(MARK))
  ok('空回复不算完成', !m.hasDoneMark(''))
}
