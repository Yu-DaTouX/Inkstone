/** 执行当前stopRun/fail方法，模拟close同步触发提前退出，不创建子代理。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
const source = await readFile('src/main/subagents.ts', 'utf8')
const stopStart = source.indexOf('  private async stopRun(')
const failStart = source.indexOf('  private async fail(')
const stop = source.slice(stopStart, source.indexOf('\n  /**', stopStart))
const fail = source.slice(failStart, source.indexOf('\n  /**', failStart))
const { code } = await transform(`class Fixture { ${stop}\n${fail}\n } globalThis.Fixture=Fixture`, { loader: 'ts' })
const context = { clearTimeout, Date }
runInNewContext(code, context)
const host = new context.Fixture()
const snapshots = []
const run = { id: 'r', status: 'running', error: '旧错误', rpc: {} }
host.runs = new Map([['r', run]])
host.emit = current => snapshots.push({ status: current.status, error: current.error })
host.finalize = async () => {}
let closing = false
run.rpc.command = async () => { assert.equal(run.status, 'cancelled'); throw new Error('abort fixture failure') }
run.rpc.close = async () => {
  if (closing) return
  closing = true
  await host.fail('r', 'pi 子进程提前退出')
}
await host.stopRun(run, false)
assert.equal(run.status, 'cancelled')
assert.equal(run.endReason, 'stopped')
assert.equal(run.error, undefined)
assert.equal(run.latestActivity, '已停止')
assert.equal(snapshots.every(row => row.status === 'cancelled' && row.error === undefined), true)
console.log('subagent-stop-intent: 6 assertions passed (不派子代理、不启动RPC)')
