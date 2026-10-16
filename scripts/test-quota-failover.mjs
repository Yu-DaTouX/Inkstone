export async function runQuotaFailoverTests(report) {
  const m = await import('../out/test/quota-failover.mjs')
  const ok = (label, cond) => report(!!cond, label)
  const keys = ['a', 'b', 'c', 'd']

  ok('从当前账号的下一个往后轮', m.failoverOrder(keys, 'b').join() === 'c,d,a')
  ok('到头回到最前面', m.failoverOrder(keys, 'd').join() === 'a,b,c')
  ok('已试过的账号不再进入', m.failoverOrder(keys, 'a', ['b', 'd']).join() === 'c')
  ok('当前账号不在列表里时按保存顺序', m.failoverOrder(keys, undefined).join() === 'a,b,c,d')
  ok('只有当前账号时没有候选', m.failoverOrder(['a'], 'a').length === 0)

  const pick = m.pickFailover([{ key: 'c', blocked: true, resetAt: 500 }, { key: 'd', blocked: false }, { key: 'a', blocked: false }])
  ok('取顺序里第一个没被卡住的', pick.ok && pick.key === 'd')
  ok('查不到额度的账号不当作可用', m.pickFailover([{ key: 'c', blocked: false, unknown: true }]).ok === false)
  const none = m.pickFailover([{ key: 'c', blocked: true, resetAt: 900 }, { key: 'd', blocked: true, resetAt: 400 }])
  ok('都用尽时给出最早恢复的时间', !none.ok && none.earliestResetAt === 400)
  ok('都用尽且没有时间时不编造', m.pickFailover([{ key: 'c', blocked: true }]).earliestResetAt === undefined)

  const NOW = 1_000_000_000_000
  ok('换上不久又用尽 → 沿用已试列表，不来回切', m.failoverSkip(['a', 'b'], NOW - 60_000, NOW).join() === 'a,b')
  ok('换上后跑了足够久 → 清空，已恢复的账号可换回（交替）', m.failoverSkip(['a', 'b'], NOW - m.FAILOVER_CHAIN_MS, NOW).length === 0)
  ok('从未换过号 → 不跳过', m.failoverSkip(['a'], 0, NOW).length === 0)
  const alternate = m.failoverOrder(['a', 'b'], 'b', m.failoverSkip(['a', 'b'], NOW - m.FAILOVER_CHAIN_MS, NOW))
  ok('两个账号：B 用尽时 A 重新成为候选', alternate.join() === 'a')
}
