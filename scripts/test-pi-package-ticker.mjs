import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createPiPackageActivationTicker } = await compile('src/main/capabilities/pi-package-scheduler.ts')
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const make = () => {
    const logs = []
    const errors = []
    const ticker = createPiPackageActivationTicker({ log: (text) => logs.push(text), onError: (error) => errors.push(error), delayMs: 5 })
    return { ticker, logs, errors }
  }

  const idle = make()
  idle.ticker.request()
  await wait(30)
  ok(idle.logs.length === 0 && idle.errors.length === 0, '调度器未就绪时请求不做任何事')

  const coalesce = make()
  let ticks = 0
  let results = [{ operationId: 'op1', state: 'deferred', detail: '会话忙' }]
  coalesce.ticker.attach({ tick: async () => { ticks++; return results } })
  coalesce.ticker.request()
  coalesce.ticker.request()
  coalesce.ticker.request()
  await wait(40)
  ok(ticks === 1, '短时间内多次请求合并为一次 tick')
  ok(coalesce.logs.length === 1 && coalesce.logs[0].includes('op1') && coalesce.logs[0].includes('暂缓'), '暂缓结果写一条日志')
  coalesce.ticker.request()
  await wait(40)
  ok(ticks === 2 && coalesce.logs.length === 1, '同一暂缓原因不重复写日志')
  results = [{ operationId: 'op1', state: 'deferred', detail: '等信任' }]
  coalesce.ticker.request()
  await wait(40)
  ok(coalesce.logs.length === 2 && coalesce.logs[1].includes('等信任'), '暂缓原因变化时再写一条')
  results = [{ operationId: 'op1', state: 'resumed', detail: '' }]
  coalesce.ticker.request()
  await wait(40)
  ok(coalesce.logs.at(-1).includes('已激活并续接原目标'), '激活成功写日志')
  results = [{ operationId: 'op1', state: 'deferred', detail: '等信任' }]
  coalesce.ticker.request()
  await wait(40)
  ok(coalesce.logs.at(-1).includes('暂缓'), '结束后清掉暂缓记录，同一原因再次暂缓仍会提示')
  results = [{ operationId: 'op2', state: 'failed', detail: '冒烟失败' }, { operationId: 'op3', state: 'acquiring', detail: '' }]
  const before = coalesce.logs.length
  coalesce.ticker.request()
  await wait(40)
  ok(coalesce.logs.length === before + 1 && coalesce.logs.at(-1).includes('未能激活：冒烟失败'), '失败写日志，其他状态不写')

  const busy = make()
  let release
  let calls = 0
  busy.ticker.attach({ tick: () => { calls++; return calls === 1 ? new Promise((done) => { release = () => done([]) }) : Promise.resolve([]) } })
  busy.ticker.request()
  await wait(30)
  busy.ticker.request()
  busy.ticker.request()
  await wait(30)
  ok(calls === 1, 'tick 进行中时不并发再起')
  release()
  await wait(40)
  ok(calls === 2, '进行中收到的请求在结束后补跑一次')

  const failing = make()
  failing.ticker.attach({ tick: async () => { throw new Error('boom') } })
  failing.ticker.request()
  await wait(30)
  ok(failing.errors.length === 1 && failing.errors[0].message === 'boom', 'tick 抛错交给错误上报')
  failing.ticker.attach({ tick: async () => [] })
  failing.ticker.request()
  await wait(30)
  ok(failing.errors.length === 1, '出错后仍可继续调度')
})
