export async function runSubagentUsageTests(ok) {
  const { accumulateUsage, ingestUsageSnapshot, normalizeSubagentContextUsage } = await import('../out/test/subagent-usage.mjs')

  console.log('\n--- H-10b 子代理累计 usage ---')
  const u = (input, output, cacheRead = 0, cacheWrite = 0, totalTokens = input + output, cost = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost
  })

  ok(accumulateUsage({}).reportedMessages === 0, '没有快照时 reportedMessages=0')
  ok(accumulateUsage({}).input === null, '没有快照时字段为 null（未知），不猜 0')

  let snaps = ingestUsageSnapshot({}, 'm1', u(10, 5))
  snaps = ingestUsageSnapshot(snaps, 'm1', u(100, 50))
  const single = accumulateUsage(snaps)
  ok(single.input === 100 && single.output === 50, '同一消息的 final 覆盖增量，不翻倍')
  ok(single.reportedMessages === 1, 'reportedMessages 只算一条消息')

  snaps = ingestUsageSnapshot(snaps, 'm1', u(100, 50))
  ok(accumulateUsage(snaps).input === 100, '重放同一 id 不重复相加')

  snaps = ingestUsageSnapshot(snaps, 'm2', u(20, 10, 4, 2))
  const two = accumulateUsage(snaps)
  ok(two.input === 120 && two.output === 60, '不同消息的快照相加')
  ok(two.cacheRead === 4 && two.cacheWrite === 2, '缓存字段分别累计')
  ok(two.reportedMessages === 2, 'reportedMessages 反映消息数')

  ok(Object.keys(ingestUsageSnapshot({}, '', u(1, 1))).length === 0, '空 messageId 不写入')


  const context = normalizeSubagentContextUsage({ tokens: 34_000, contextWindow: 272_000, percent: 99 })
  ok(context?.tokens === 34_000 && context.percent === 12.5, '原生上下文已用/窗口计算占比，不信任不一致百分比')
  ok(normalizeSubagentContextUsage(undefined) === undefined, '旧记录无原生上下文快照时保持未知')
  ok(normalizeSubagentContextUsage({ tokens: null, contextWindow: 272_000 })?.tokens === null, '窗口已知但占用未知，不猜 0')
  ok(normalizeSubagentContextUsage({ tokens: 0, contextWindow: 100 })?.percent === 0, '真正报告的零占用仍是已知零')
  ok(normalizeSubagentContextUsage({ tokens: NaN, contextWindow: -1 }) === undefined, '非法上下文数值不能传到界面')
  ok(normalizeSubagentContextUsage({ input: 900_000, output: 100 }) === undefined, '累计 usage 不能冒充上下文占用')

  const many = { m1: u(1, 1), m2: u(2, 2), m3: u(3, 3) }
  ok(accumulateUsage(many).input === 6, '统计只取决于按 id 保存的快照，与 transcript 长度无关')
}
