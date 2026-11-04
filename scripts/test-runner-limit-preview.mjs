#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outfile = join(process.cwd(), 'out', 'test', 'runner-limit-preview.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({ entryPoints: ['src/main/runners.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
const { RunnerRegistry } = await import(pathToFileURL(outfile).href)

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}

const mkAgent = (cwd) => ({
  state: { sessionId: undefined, sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd },
  switched: [],
  getState() { return this.state },
  getPendingUiCount() { return 0 },
  hasRunningBash() { return false },
  getConn() { return { state: 'ready', detail: '' } },
  setRunnerGeneration() {},
  async start() { return { ok: true } },
  async stop() {},
  async switchSession(file) { this.switched.push(file); this.state = { ...this.state, sessionFile: file, sessionId: file }; return { ok: true } },
  async newSession() { return { ok: true } },
  queueSnapshot() { return { steering: [], followUp: [] } },
  async restoreQueueSnapshot() { return { ok: true } }
})

function registry(limit) {
  const made = []
  const reg = new RunnerRegistry({ limit, createAgent: (_id, cwd) => { const agent = mkAgent(cwd); made.push(agent); return agent } })
  return { reg, made }
}

console.log('--- 实例都在跑时，切会话只读打开，不占运行位 ---')
{
  const { reg, made } = registry(2)
  const a = await reg.select({ cwd: 'E:/p', sessionFile: 'a.jsonl' })
  reg.agentOf(a.id).state.isAgentRunning = true
  const b = await reg.select({ cwd: 'E:/q', sessionFile: 'b.jsonl' })
  reg.agentOf(b.id).state.isAgentRunning = true
  check(reg.size === 2, '两个实例都在跑，已到上限')
  const view = await reg.select({ cwd: 'E:/r', sessionFile: 'c.jsonl', preview: true })
  check(view.ok && view.deferred === true && view.deferredReason === 'limit', '切会话返回只读延后，不报错', JSON.stringify(view))
  check(reg.size === 2 && made.length === 2, '只读查看不新建实例')
  check(made.every((agent) => agent.switched.length === 1), '只读查看不把在跑的实例切走')
  const send = await reg.select({ cwd: 'E:/r', sessionFile: 'c.jsonl' })
  check(!send.ok && send.error.includes('上限'), '真要发消息时才提示上限', JSON.stringify(send))
  reg.agentOf(b.id).state.isAgentRunning = false
  const after = await reg.select({ cwd: 'E:/r', sessionFile: 'c.jsonl' })
  check(after.ok && after.via === 'reuse' && after.id === b.id, '有实例跑完后，发消息复用空出来的实例', JSON.stringify(after))
}

console.log('--- 同目录有实例拿着执行占位时，其他空闲实例仍可复用 ---')
{
  const { reg } = registry(2)
  const a = await reg.select({ cwd: 'E:/p', sessionFile: 'a.jsonl' })
  const b = await reg.select({ cwd: 'E:/p', sessionFile: 'b.jsonl', activate: false })
  check(a.id !== b.id && reg.size === 2, '同目录建出两个实例')
  await reg.select({ cwd: 'E:/p', sessionFile: 'a.jsonl' })
  check(reg.admitExecute(a.id).ok, 'a 拿到执行占位')
  const next = await reg.select({ cwd: 'E:/r', sessionFile: 'c.jsonl', preview: true })
  check(next.ok && !next.deferred && next.id === b.id, '复用同目录里空闲的 b，而不是报上限', JSON.stringify(next))
  const own = await reg.select({ cwd: 'E:/s', sessionFile: 'd.jsonl', preview: true })
  check(own.ok && own.id !== a.id, '拿着占位的 a 本身不会被切走', JSON.stringify(own))
}

console.log(`\n运行位只在运行时占用：${checks} 项通过`)
