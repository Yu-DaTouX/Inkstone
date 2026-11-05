#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

await mkdir(join(process.cwd(), 'out'), { recursive: true })
const dir = await mkdtemp(join(process.cwd(), 'out', 'test-terminal-reveal-'))
let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

try {
  const file = join(dir, 'push.mjs')
  await build({
    stdin: {
      contents: "export { consumeShellPush } from './src/renderer/src/state/push-consumers'\nexport { noteTerminalAgent } from './src/renderer/src/features/terminal/terminal-agent-activity'",
      resolveDir: process.cwd()
    },
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
  const { consumeShellPush } = await import(pathToFileURL(file).href)

  let state
  const makeCtx = () => {
    const reveals = []
    const ctx = {
      get: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      alertAttention: () => {},
      pushNotice: (list) => list,
      applyBrowserVisibility: () => {},
      revealBrowser: () => {},
      revealTerminal: (owner, id) => reveals.push([owner, id]),
      t: (key) => key
    }
    return { ctx, reveals }
  }
  const push = (payload) => ({ ch: 'terminal', payload: { id: 't1', kind: 'agent', ...payload } })
  state = { terminals: [] }

  await check('agent 开始操作终端：请求打开面板并切到这个终端', () => {
    const { ctx, reveals } = makeCtx()
    assert.equal(consumeShellPush(push({ owner: 'E:/s/A.jsonl', agentPhase: 'start', agentAction: 'run' }), state, ctx), true)
    assert.deepEqual(reveals, [['E:/s/A.jsonl', 't1']])
  })

  await check('操作结束不再弹面板', () => {
    const { ctx, reveals } = makeCtx()
    consumeShellPush(push({ owner: 'E:/s/A.jsonl', agentPhase: 'end', agentAction: 'run' }), state, ctx)
    assert.deepEqual(reveals, [])
  })

  await check('没有归属的终端事件不弹面板', () => {
    const { ctx, reveals } = makeCtx()
    consumeShellPush(push({ agentPhase: 'start', agentAction: 'run' }), state, ctx)
    assert.deepEqual(reveals, [])
  })

  await check('数据 / 状态事件不触发打开面板', () => {
    const { ctx, reveals } = makeCtx()
    consumeShellPush({ ch: 'terminal', payload: { id: 't1', kind: 'status', status: { state: 'working' } } }, state, ctx)
    assert.deepEqual(reveals, [])
  })

  console.log(`test-terminal-agent-reveal: ${pass} 项全部通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
