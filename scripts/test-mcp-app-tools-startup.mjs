import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { awaitMcpAppToolsForStart, MCP_APP_TOOLS_COLD_WAIT_MS } = await compile('src/main/mcp/app-tools-startup.ts')
  const never = () => new Promise(() => {})
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  ok(MCP_APP_TOOLS_COLD_WAIT_MS <= 2000, '没有快照时最多短暂等待 2 秒')

  {
    const started = Date.now()
    const result = await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', refresh: never(), exists: () => true })
    ok(result === 'snapshot' && Date.now() - started < 100, '已有快照：不等后台刷新，直接用现有快照启动', `${result} ${Date.now() - started}ms`)
  }

  {
    let finished = false
    const refresh = sleep(150).then(() => { finished = true })
    const result = await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', refresh, exists: () => true })
    ok(result === 'snapshot' && finished === false, '已有快照时刷新留在后台继续跑')
    await refresh
    ok(finished === true, '后台刷新照常完成，之后新启动的会话会读到新快照')
  }

  {
    const failing = Promise.reject(new Error('refresh failed'))
    const result = await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', refresh: failing, exists: () => true })
    await sleep(10)
    ok(result === 'snapshot', '已有快照时后台刷新失败不影响启动，也不产生未处理拒绝')
  }

  {
    const started = Date.now()
    const result = await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', refresh: never(), exists: () => false, coldWaitMs: 120 })
    const took = Date.now() - started
    ok(result === 'timeout' && took >= 100 && took < 1000, '没有任何快照且刷新很慢：只等到上限就启动', `${result} ${took}ms`)
  }

  {
    const started = Date.now()
    const result = await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', refresh: sleep(30), exists: () => false, coldWaitMs: 2000 })
    ok(result === 'refreshed' && Date.now() - started < 500, '没有快照但刷新很快：等到刷新完成就启动', result)
  }

  {
    const result = await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', refresh: Promise.reject(new Error('x')), exists: () => false, coldWaitMs: 500 })
    ok(result === 'refreshed', '没有快照且刷新失败：不挂起，直接启动')
  }

  {
    ok((await awaitMcpAppToolsForStart({ snapshotPath: 'snap.json', exists: () => false })) === 'none', '没有刷新回调时不等待')
    ok((await awaitMcpAppToolsForStart({ refresh: sleep(10), exists: () => true, coldWaitMs: 300 })) === 'refreshed', '没有快照路径视为没有快照')
  }
})
