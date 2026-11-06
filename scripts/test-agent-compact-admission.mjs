#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-compact-admission-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

const outfile = join(process.cwd(), 'out', 'test', 'agent-compact-admission.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: { contents: "export { AgentController } from './src/main/agent'", resolveDir: process.cwd(), loader: 'ts' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'compact-admission-electron-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'compact-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'compact-electron' }, () => ({
        loader: 'js',
        contents: `
          export class BrowserWindow {}
          export const session = { fromPartition() {} }
          export const app = { getLocale: () => 'en-US', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
          export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
          export const safeStorage = { isEncryptionAvailable: () => false }
        `
      }))
    }
  }],
  logLevel: 'silent'
})
const { AgentController } = await import(pathToFileURL(outfile).href)

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}

function controller(onCompact) {
  const releases = []
  const ctl = new AgentController({ push: () => {}, cwd: process.cwd() })
  ctl.state = { sessionId: 's', sessionFile: join(root, 's.jsonl'), cwd: process.cwd(), isStreaming: false, isCompacting: false }
  ctl.capabilityOpts = { runnerGeneration: 1, execution: {
    claim: () => ({ ok: true, token: 7 }),
    confirm: () => true,
    release: (token) => releases.push(token)
  } }
  ctl.refreshState = async () => {}
  ctl.refreshStats = async () => {}
  ctl.hydrate = async () => {}
  ctl.rpc = { running: true, command: async (type) => {
    if (type === 'compact') await onCompact?.(ctl)
    return { success: true, data: {} }
  } }
  return { ctl, releases }
}

const armed = (ctl) => ctl.executionAdmissionTimer !== undefined
const disarm = (ctl) => { if (ctl.executionAdmissionTimer) clearTimeout(ctl.executionAdmissionTimer) }

console.log('--- 手动压缩：命令回执早于 get_state 刷新 ---')
{
  const { ctl } = controller(async (c) => {
    c.handleEvent({ type: 'compaction_start', reason: 'manual' })
    c.state = { ...c.state, isCompacting: true }
    c.handleEvent({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'x' } })
  })
  const result = await ctl.compact()
  check(result.ok, '压缩成功')
  check(ctl.state.isCompacting === false, 'compaction_end 后立即视为不在压缩')
  check(armed(ctl), '压缩结束后安排释放执行占位，不会一直占着工作目录')
  disarm(ctl)
}

console.log('--- 自动压缩：回合结束时还在压缩 ---')
{
  const { ctl } = controller()
  ctl.executionAdmissionToken = 7
  ctl.agentRunning = true
  ctl.state = { ...ctl.state, isAgentRunning: true, isCompacting: true }
  ctl.handleEvent({ type: 'compaction_start', reason: 'threshold' })
  ctl.setAgentRunning(false)
  check(ctl.executionAdmissionToken === 7 && !armed(ctl), '压缩中回合结束先不释放')
  ctl.handleEvent({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 'x' } })
  check(armed(ctl), '自动压缩结束后补上释放')
  disarm(ctl)
}

console.log('--- 溢出压缩后马上重跑：不提前释放 ---')
{
  const { ctl, releases } = controller()
  ctl.executionAdmissionToken = 7
  ctl.handleEvent({ type: 'compaction_start', reason: 'overflow' })
  ctl.handleEvent({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 'x' } })
  check(!armed(ctl) && releases.length === 0 && ctl.executionAdmissionToken === 7, 'willRetry 时占位留给重跑的回合')
}

console.log('--- 运行已结束后收尾：立即释放，只有尚未观察到运行时才留宽限 ---')
{
  const { ctl, releases } = controller()
  ctl.executionAdmissionToken = 7
  ctl.setAgentRunning(true)
  ctl.agentRunning = false
  ctl.settleExecutionAdmission()
  check(releases.length === 1 && ctl.executionAdmissionToken === undefined && !armed(ctl), '已观察到运行且已结束：同目录其他会话不必再等宽限')
}
{
  const { ctl, releases } = controller()
  ctl.executionAdmissionToken = 7
  ctl.settleExecutionAdmission()
  check(releases.length === 0 && armed(ctl), '发送刚返回、运行还没开始：保留宽限防止并发抢占')
  disarm(ctl)
}

await rm(root, { recursive: true, force: true })
console.log(`\n压缩后释放执行占位：${checks} 项通过`)
