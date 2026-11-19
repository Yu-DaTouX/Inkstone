import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { build } from '../node_modules/esbuild/lib/main.js'

const result = await build({
  stdin: {
    contents: `export { runShutdownSteps } from './src/main/shutdown.ts'\nexport { createQuitAfterShutdown, prepareUpdateAfterWriters, UPDATE_WRITER_STEPS } from './src/main/shutdown-update.ts'`,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { runShutdownSteps, createQuitAfterShutdown, prepareUpdateAfterWriters, UPDATE_WRITER_STEPS } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

console.log('▌退出前更新备份：写入者先停，预检在后')
{
  const order = []
  const steps = [
    { name: 'runners', run: () => { order.push('runners'); } },
    { name: 'subagents', run: () => { order.push('subagents'); } },
    { name: 'terminals', run: () => { order.push('terminals'); } },
    { name: 'content-search', run: () => { order.push('content-search'); } }
  ]
  const outcomes = await runShutdownSteps(steps)
  const control = {
    prepare: async (options) => {
      order.push('preflight')
      ok(options?.signal instanceof AbortSignal, '预检收到可取消的 AbortSignal')
      return { install: true, reason: 'backed-up' }
    },
    cancel: () => { order.push('cancel'); }
  }
  const prepared = await prepareUpdateAfterWriters(outcomes, control, { log: () => {} })
  ok(order.join('>') === 'runners>subagents>terminals>content-search>preflight', '预检在全部退出步骤之后执行', order)
  ok(prepared.install === true && prepared.skipped === undefined, '写入者都停下时允许退出安装', prepared)
}

console.log('▌写入者步骤超时：不备份、不安装、明确记录')
{
  const order = []
  const steps = [
    { name: 'runners', run: () => new Promise(() => {}), timeoutMs: 20 },
    { name: 'subagents', run: () => { order.push('subagents'); } },
    { name: 'terminals', run: () => { order.push('terminals'); } },
    { name: 'content-search', run: () => { order.push('content-search'); } }
  ]
  const outcomes = await runShutdownSteps(steps)
  let prepared = 0
  const warnings = []
  const control = { prepare: async () => { prepared += 1; return { install: true, reason: 'backed-up' } }, cancel: () => { order.push('cancel'); } }
  const result = await prepareUpdateAfterWriters(outcomes, control, { warn: (message) => warnings.push(message) })
  ok(outcomes.find((outcome) => outcome.name === 'runners')?.timedOut === true, '超时步骤被标记为 timedOut')
  ok(prepared === 0, '写入者超时不触发备份')
  ok(order.includes('cancel') && result.skipped === 'writers-unconfirmed' && result.install === false, '取消自动安装并记录跳过原因', result)
  ok(warnings.some((message) => message.includes('runners(timeout)')), '日志写明是哪一个写入者超时', warnings)
  ok(order.join('>') === 'subagents>terminals>content-search>cancel', '超时后仍继续其它清理步骤，最后才判定', order)
}

console.log('▌写入者步骤报错：同样不放行')
{
  const outcomes = await runShutdownSteps([
    { name: 'runners', run: () => { throw new Error('stop failed') } },
    { name: 'terminals', run: () => {} }
  ])
  let prepared = 0
  const warnings = []
  const control = { prepare: async () => { prepared += 1; return { install: true, reason: 'backed-up' } }, cancel: () => {} }
  const result = await prepareUpdateAfterWriters(outcomes, control, { warn: (message) => warnings.push(message) })
  ok(prepared === 0 && result.install === false, '写入者报错不触发备份')
  ok(warnings.some((message) => message.includes('runners(failed)')), '日志区分失败与超时', warnings)
}

console.log('▌预检超时/失败：显式中止，晚到结果不放行')
{
  const outcomes = await runShutdownSteps([{ name: 'runners', run: () => {} }])
  let signal
  const control = {
    prepare: (options) => {
      signal = options?.signal
      return new Promise(() => {})
    },
    cancel: () => { control.cancelled = true }
  }
  const warnings = []
  const result = await prepareUpdateAfterWriters(outcomes, control, { timeoutMs: 20, warn: (message) => warnings.push(message) })
  ok(signal?.aborted === true && control.cancelled === true, '超时后中止信号并调用取消')
  ok(result.skipped === 'timeout' && result.install === false, '超时不安装', result)
  ok(warnings.some((message) => message.includes('timed out')), '记录超时')

  const failing = {
    prepare: async () => { throw new Error('backup crashed') },
    cancel: () => { failing.cancelled = true }
  }
  const failed = await prepareUpdateAfterWriters(outcomes, failing, { warn: () => {} })
  ok(failed.skipped === 'failed' && failed.install === false && failing.cancelled === true, '备份抛错不放行并取消', failed)
}

console.log('▌没有更新控制：直接跳过')
{
  const outcomes = await runShutdownSteps([{ name: 'runners', run: () => {} }])
  const result = await prepareUpdateAfterWriters(outcomes, null)
  ok(result.install === false && result.skipped === 'no-control', '没有控制器时不安装', result)
  ok(UPDATE_WRITER_STEPS.join(',') === 'runners,subagents,terminals', '写入者步骤名单固定')
}

console.log('▌退出收尾：清理完成后显式安装一次，无法退出时兜底')
{
  const order = []
  let releaseDataRoot
  let unlocked
  const unlocking = new Promise((resolve) => { unlocked = resolve })
  const coordinator = createQuitAfterShutdown(async () => {
    order.push('writers', 'preflight')
    await new Promise((resolve) => { releaseDataRoot = resolve; unlocked() })
    order.push('unlocked')
  }, () => { order.push('install'); return true }, () => { order.push('plain quit') }, 20)
  const request = coordinator.request()
  await unlocking
  ok(coordinator.request() === request && !coordinator.allowQuit(), '并发退出合并，释放数据锁前不能退出')
  ok(order.join('>') === 'writers>preflight', '清理未完成时不能开始安装', order)
  releaseDataRoot()
  await request
  ok(order.join('>') === 'writers>preflight>unlocked>install', '清理及数据锁释放后只尝试一次安装', order)
  ok(coordinator.allowQuit(), '允许更新器随后发起的退出')
  await new Promise((resolve) => setTimeout(resolve, 40))
  ok(!order.includes('plain quit'), '更新器已发起退出时取消兜底')
}
{
  let installs = 0
  let quits = 0
  let notifyQuit
  const quit = new Promise((resolve) => { notifyQuit = resolve })
  const coordinator = createQuitAfterShutdown(async () => {}, () => { installs += 1; return true }, () => { quits += 1; notifyQuit() }, 20)
  await coordinator.request()
  ok(installs === 1 && quits === 0, '安装器没有同步报错时先等其发起退出')
  await quit
  await coordinator.request()
  ok(installs === 1 && quits === 1 && coordinator.allowQuit(), '安装器没有发起退出时兜底只退出、不重试安装')
}
{
  let quits = 0
  const coordinator = createQuitAfterShutdown(async () => {}, () => false, () => { quits += 1 }, 20)
  await coordinator.request()
  await new Promise((resolve) => setTimeout(resolve, 40))
  ok(quits === 1, '不安装或安装同步失败时直接退出，不再触发兜底')
}

console.log(`退出前更新备份顺序与超时：${pass} 项通过`)
