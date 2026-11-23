import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const calls = []
  let status = 200
  let gate
  const prior = globalThis.__claudeUsageTest
  globalThis.__claudeUsageTest = {
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), auth: init.headers?.Authorization })
      if (gate) await gate
      return new Response(JSON.stringify({ five_hour: { utilization: calls.length } }), { status, headers: status === 429 ? { 'retry-after': '120' } : {} })
    }
  }
  try {
    const { claudeUsage, forgetClaudeUsage } = await compile('src/main/claude-usage.ts', {
      plugins: [{ name: 'claude-usage-electron', setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'claude-usage-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'claude-usage-stub' }, () => ({ contents: 'export const net = { fetch: (...args) => globalThis.__claudeUsageTest.fetch(...args) }' }))
      } }]
    })
    let release
    gate = new Promise((resolve) => { release = resolve })
    const together = [claudeUsage('token-a'), claudeUsage('token-a'), claudeUsage('token-a')]
    release()
    gate = undefined
    const results = await Promise.all(together)
    ok(calls.length === 1 && results.every((result) => result === results[0]), '同一账号同时发起的查询合并成一次请求', JSON.stringify(calls))
    await claudeUsage('token-a')
    ok(calls.length === 1, '五分钟内重复查询直接用缓存，不再请求接口')
    await claudeUsage('token-b')
    ok(calls.length === 2 && calls[1].auth === 'Bearer token-b', '不同账号各自查询')
    forgetClaudeUsage()
    await claudeUsage('token-a')
    ok(calls.length === 3, '清掉缓存后（如用过重置卡）重新查询')
    forgetClaudeUsage()
    status = 429
    const limited = await claudeUsage('token-c').then(() => '', (error) => error.message)
    ok(/429/.test(limited) && /2/.test(limited), '429 时按 retry-after 进入冷却并提示等待时间', limited)
    const before = calls.length
    const cooling = await claudeUsage('token-c').then(() => '', (error) => error.message)
    ok(calls.length === before && cooling !== '', '冷却期内不再请求接口')
  } finally {
    if (prior === undefined) delete globalThis.__claudeUsageTest
    else globalThis.__claudeUsageTest = prior
  }
})
