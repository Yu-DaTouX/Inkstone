/*
 * 运行阶段投影单测（src/shared/run-progress.ts，实施-21 P1）。
 *
 * 覆盖：多轮工具循环、阶段优先级、取消/失败、没有可见 thinking 时不显示推理、
 * 工具结束后回到等待模型、长耗时阈值、空白回合。
 */

export async function runRunProgressTests(ok, mod) {
  const { deriveRunProgress, runPhaseIsActive } = mod
  const base = {
    running: true,
    streaming: false,
    tool: null,
    thinking: false,
    requested: false,
    terminal: null,
    startedAt: 1_000_000,
    now: 1_010_000
  }
  const phaseOf = (over) => deriveRunProgress({ ...base, ...over }).phase

  /* ── 阶段由真实事件推进 ── */
  ok(phaseOf({ running: false, startedAt: null }) === 'settled', '没有在跑就是 settled')
  ok(phaseOf({}) === 'preparing', 'agent_start 之后、还没请求模型 → preparing')
  ok(phaseOf({ requested: true }) === 'requesting', '已发出请求 → requesting')
  ok(phaseOf({ requested: true, thinking: true }) === 'thinking', '收到可见思考流 → thinking')
  ok(phaseOf({ requested: true, tool: { name: 'read' } }) === 'tool', '工具执行 → tool')
  ok(
    phaseOf({ requested: true, thinking: true, tool: { name: 'read' } }) === 'tool',
    '工具优先于 thinking（模型可能在工具前想过）'
  )
  ok(phaseOf({ requested: true, streaming: true }) === 'responding', '正文在流 → responding')
  ok(
    phaseOf({ requested: true, tool: { name: 'read' }, streaming: true }) === 'tool',
    '工具优先于正文（工具在跑时正文不推进）'
  )

  /* ── 没有可见 thinking 就不显示“正在推理” ── */
  const noThink = deriveRunProgress({ ...base, requested: true, thinking: false })
  ok(noThink.phase === 'requesting', '没收到 thinking 时停在 requesting，不假装在推理')

  /* ── 工具结束后等待模型：回到 requesting ── */
  const afterTool = deriveRunProgress({ ...base, requested: true, tool: null, streaming: false, thinking: false })
  ok(afterTool.phase === 'requesting', '工具结束后回到 requesting（不是停在 tool）')

  /* ── 同一回合多轮工具 → 模型可以来回切 ── */
  const round1 = phaseOf({ requested: true, tool: { name: 'read' } })
  const round1done = phaseOf({ requested: true, tool: null })
  const round2 = phaseOf({ requested: true, tool: { name: 'bash' } })
  ok(
    round1 === 'tool' && round1done === 'requesting' && round2 === 'tool',
    '工具 → 等待模型 → 再工具可以多次往返（没有线性完成度）'
  )

  /* ── 终态优先，且取消 / 失败可区分 ── */
  ok(phaseOf({ terminal: 'completed' }) === 'settled', 'completed → settled')
  ok(phaseOf({ terminal: 'failed' }) === 'failed', 'failed → failed')
  ok(phaseOf({ terminal: 'stopped' }) === 'cancelled', 'stopped → cancelled（用户主动停）')
  ok(phaseOf({ terminal: 'interrupted' }) === 'cancelled', 'interrupted → cancelled（中断）')
  ok(
    phaseOf({ terminal: 'failed', tool: { name: 'read' }, streaming: true }) === 'failed',
    '终态优先于任何运行中阶段（不会显示成还在读文件）'
  )
  ok(phaseOf({ terminal: 'completed', running: false }) === 'settled', '完成后 running=false 仍是 settled')

  /* ── 附注与长耗时 ── */
  const withTool = deriveRunProgress({ ...base, requested: true, tool: { name: 'grep' } })
  ok(withTool.detail === 'grep', 'tool 阶段带出工具名')
  ok(deriveRunProgress({ ...base, requested: true }).detail === undefined, '非 tool 阶段没有工具附注')

  ok(deriveRunProgress({ ...base, now: base.startedAt + 29_000 }).long === false, '29s 还不算长耗时')
  ok(deriveRunProgress({ ...base, now: base.startedAt + 30_000 }).long === true, '30s 起算长耗时')
  ok(
    deriveRunProgress({ ...base, terminal: 'completed', now: base.startedAt + 90_000 }).long === false,
    '已经结束的回合不再标长耗时'
  )
  ok(
    deriveRunProgress({ ...base, now: base.startedAt + 90_000, longMs: 120_000 }).long === false,
    '长耗时阈值可以按调用方覆盖'
  )
  ok(deriveRunProgress({ ...base, startedAt: null }).elapsedMs === 0, '没有开始时间时不编造时长')

  ok(runPhaseIsActive('tool') === true && runPhaseIsActive('settled') === false, '只有进行中的阶段算 active')
}

export default runRunProgressTests
