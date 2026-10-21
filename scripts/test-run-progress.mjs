export async function runRunProgressTests(ok, mod) {
  const { deriveRunProgress, resolveRunClock } = mod
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

  const first = resolveRunClock(null, { identity: 'session-a/run-a/turn-1', running: true, now: 1000 })
  ok(first?.startedAt === 1000, '首次运行缺少报告时从进入运行起算')
  ok(resolveRunClock(first, { identity: first.identity, running: true, now: 9000 })?.startedAt === 1000, '同一运行的秒级刷新不重置起点')
  const second = resolveRunClock(first, { identity: 'session-b/run-b/turn-1', running: true, now: 9000 })
  ok(second?.startedAt === 9000, '两个都在运行的会话之间切换，不继承旧计时')
  ok(resolveRunClock(second, { identity: first.identity, running: true, startedAt: 1000, now: 9500 })?.startedAt === 1000, '切回有原生消息时间的会话恢复该回合起点')
  ok(resolveRunClock(first, { identity: 'session-a/run-a/turn-2', running: true, now: 10_000 })?.startedAt === 10_000, '同会话新回合也换起点')
  ok(resolveRunClock(first, { identity: first.identity, running: false, now: 10_000 }) === null, '结束清空运行计时')
  ok(resolveRunClock(first, { identity: 'new', running: true, startedAt: NaN, now: 12_000 })?.startedAt === 12_000, '非法报告起点不污染新运行计时')

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

  const noThink = deriveRunProgress({ ...base, requested: true, thinking: false })
  ok(noThink.phase === 'requesting', '没收到 thinking 时停在 requesting，不假装在推理')

  const afterTool = deriveRunProgress({ ...base, requested: true, tool: null, streaming: false, thinking: false })
  ok(afterTool.phase === 'requesting', '工具结束后回到 requesting（不是停在 tool）')

  const round1 = phaseOf({ requested: true, tool: { name: 'read' } })
  const round1done = phaseOf({ requested: true, tool: null })
  const round2 = phaseOf({ requested: true, tool: { name: 'bash' } })
  ok(
    round1 === 'tool' && round1done === 'requesting' && round2 === 'tool',
    '工具 → 等待模型 → 再工具可以多次往返（没有线性完成度）'
  )

  ok(phaseOf({ terminal: 'completed' }) === 'settled', 'completed → settled')
  ok(phaseOf({ terminal: 'failed' }) === 'failed', 'failed → failed')
  ok(phaseOf({ terminal: 'stopped' }) === 'cancelled', 'stopped → cancelled（用户主动停）')
  ok(phaseOf({ terminal: 'interrupted' }) === 'cancelled', 'interrupted → cancelled（中断）')
  ok(
    phaseOf({ terminal: 'failed', tool: { name: 'read' }, streaming: true }) === 'failed',
    '终态优先于任何运行中阶段（不会显示成还在读文件）'
  )
  ok(phaseOf({ terminal: 'completed', running: false }) === 'settled', '完成后 running=false 仍是 settled')

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

  ok(phaseOf({ running: true, compacting: true }) === 'compacting', '压缩中 → compacting（不再误报成生成回复）')
  ok(phaseOf({ streaming: true, compacting: true, requested: true }) === 'compacting', '压缩期间 isStreaming 为真也显示压缩')
  ok(phaseOf({ compacting: true, terminal: 'failed' }) === 'failed', '终态仍优先于压缩')
  ok(
    deriveRunProgress({ ...base, compacting: true, now: base.startedAt + 90_000 }).long === false,
    '压缩再久也不标长耗时（文案保持「压缩中」）'
  )
}

export default runRunProgressTests
