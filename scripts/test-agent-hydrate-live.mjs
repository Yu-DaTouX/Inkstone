#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-hydrate-live-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

const outfile = join(process.cwd(), 'out', 'test', 'agent-hydrate-live.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: { contents: "export { AgentController } from './src/main/agent'", resolveDir: process.cwd(), loader: 'ts' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'hydrate-live-electron-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'compact-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'compact-electron' }, () => ({
        loader: 'js',
        contents: `
          export class BrowserWindow {}
          export const session = { fromPartition() {} }
          export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
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

function controller() {
  const ctl = new AgentController({ push: () => {}, cwd: process.cwd() })
  ctl.state = { sessionId: 's', sessionFile: join(root, 's.jsonl'), cwd: process.cwd(), isStreaming: false, isCompacting: false }
  ctl.capabilityOpts = { runnerGeneration: 1 }
  ctl.refreshState = async () => {}
  ctl.refreshStats = async () => {}
  ctl.refreshTodos = async () => {}
  ctl.maybeGenerateTitle = async () => {}
  ctl.persistTurnTiming = async () => {}
  ctl.pushQuestionLog = () => {}
  ctl.pushApprovalLog = () => {}
  ctl.reclaimSavedQueue = async () => {}
  ctl.rpc = { running: true, command: async () => ({ success: true, data: { sessionId: 's', sessionFile: ctl.state.sessionFile } }) }
  return ctl
}

console.log('--- 压缩后历史刷新期间有新的工具事件：不回写旧快照 ---')
{
  const ctl = controller()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reads = 0
  ctl.readHistoryOf = async () => {
    reads += 1
    if (reads === 1) await gate
    return { messages: [], total: 0, truncated: 0, bytes: 0 }
  }
  let loads = 0
  const original = ctl.items.load.bind(ctl.items)
  ctl.items.load = (messages) => { loads += 1; original(messages) }
  ctl.agentRunning = true
  const pending = ctl.hydrate({ sessionId: 's', sessionFile: ctl.state.sessionFile })
  ctl.handleEvent({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'bash', result: { content: [] } })
  release()
  await pending
  check(loads === 0, '读取期间出现实时事件时放弃回写')
  check(ctl.hydrateDeferred !== null, '登记为回合结束后再刷新')
  ctl.setAgentRunning(false)
  await ctl.hydrate(ctl.hydrateDeferred)
  check(loads > 0, '回合结束后补做刷新')
}

await rm(root, { recursive: true, force: true })
console.log(`\n历史刷新与实时事件：${checks} 项通过`)
