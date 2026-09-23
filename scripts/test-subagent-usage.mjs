/** 子代理累计 usage（实施-11 H-10b）的纯函数测试。 */
export async function runSubagentUsageTests(ok) {
  const { accumulateUsage, ingestUsageSnapshot, normalizeSubagentUsage } = await import('../out/test/subagent-usage.mjs')

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

  /* 同一消息的流式增量→final：只保留最后一份，不重复相加 */
  let snaps = ingestUsageSnapshot({}, 'm1', u(10, 5))
  snaps = ingestUsageSnapshot(snaps, 'm1', u(100, 50))
  const single = accumulateUsage(snaps)
  ok(single.input === 100 && single.output === 50, '同一消息的 final 覆盖增量，不翻倍')
  ok(single.reportedMessages === 1, 'reportedMessages 只算一条消息')

  /* 重放同一 id 不翻倍 */
  snaps = ingestUsageSnapshot(snaps, 'm1', u(100, 50))
  ok(accumulateUsage(snaps).input === 100, '重放同一 id 不重复相加')

  /* 不同消息相加 */
  snaps = ingestUsageSnapshot(snaps, 'm2', u(20, 10, 4, 2))
  const two = accumulateUsage(snaps)
  ok(two.input === 120 && two.output === 60, '不同消息的快照相加')
  ok(two.cacheRead === 4 && two.cacheWrite === 2, '缓存字段分别累计')
  ok(two.reportedMessages === 2, 'reportedMessages 反映消息数')

  /* 空 messageId 不落 */
  ok(Object.keys(ingestUsageSnapshot({}, '', u(1, 1))).length === 0, '空 messageId 不写入')

  /* 旧记录兼容：没有持久化统计 → undefined；有 → 读回 */
  ok(normalizeSubagentUsage(undefined) === undefined, '旧记录没有 usage 字段 → 未知')
  ok(normalizeSubagentUsage({ reportedMessages: 0 }) === undefined, 'reportedMessages=0 视为未知')
  const restored = normalizeSubagentUsage({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 7, cost: 8, reportedMessages: 2 })
  ok(restored && restored.input === 3 && restored.output === 4, '有统计的旧记录按原值读回')
  ok(normalizeSubagentUsage({ reportedMessages: 1, input: 'bad', output: 2 })?.input === null, '脏字段回到 null 而不是 NaN')

  /* 转录被截尾不影响统计（统计独立于 transcript） */
  const many = { m1: u(1, 1), m2: u(2, 2), m3: u(3, 3) }
  ok(accumulateUsage(many).input === 6, '统计只取决于按 id 保存的快照，与 transcript 长度无关')
}
