#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-browser-reveal-'))
let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

try {
  const file = join(dir, 'push.mjs')
  await build({
    stdin: { contents: "export { consumeShellPush } from './src/renderer/src/state/push-consumers'", resolveDir: process.cwd() },
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
  const { consumeShellPush } = await import(pathToFileURL(file).href)

  const makeCtx = () => {
    const calls = { reveal: 0 }
    const ctx = {
      get: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      alertAttention: () => {},
      pushNotice: (list) => list,
      applyBrowserVisibility: () => {},
      revealBrowser: () => { calls.reveal += 1 },
      t: (key) => key
    }
    return { ctx, calls }
  }
  let state
  const reset = (browserState, view = 'sid-a') => {
    state = {
      peekedSessionId: null,
      session: { sessionId: view },
      browserState,
      browserStates: {},
      settings: null
    }
  }
  const push = (payload) => ({ ch: 'browser-state', payload })

  await check('agent 在本条会话里开始用浏览器：自动展开面板', () => {
    reset({ open: false })
    const { ctx, calls } = makeCtx()
    consumeShellPush(push({ open: true, url: 'https://example.com/', agentSessionId: 'sid-a' }), state, ctx)
    assert.equal(calls.reveal, 1)
    assert.equal(state.browserState.open, true)
  })

  await check('同一条会话后续的浏览器状态不再重复弹出', () => {
    reset({ open: true, url: 'https://example.com/', agentSessionId: 'sid-a' })
    const { ctx, calls } = makeCtx()
    consumeShellPush(push({ open: true, url: 'https://example.com/2', agentSessionId: 'sid-a' }), state, ctx)
    assert.equal(calls.reveal, 0)
  })

  await check('别的会话在用浏览器时不抢界面', () => {
    reset({ open: false })
    const { ctx, calls } = makeCtx()
    consumeShellPush(push({ open: true, url: 'https://example.com/', agentSessionId: 'sid-b' }), state, ctx)
    assert.equal(calls.reveal, 0)
    assert.equal(state.browserState.agentSessionId, 'sid-b', '状态照常记录，只是不弹出')
  })

  await check('用户自己打开浏览器（没有 agent 驱动）不触发自动展开', () => {
    reset({ open: false })
    const { ctx, calls } = makeCtx()
    consumeShellPush(push({ open: true, url: 'about:blank' }), state, ctx)
    assert.equal(calls.reveal, 0)
  })

  await check('后台会话推进来的浏览器状态不会覆盖当前会话的浏览器状态', () => {
    reset({ open: true, url: 'https://mine.test/', agentSessionId: 'sid-a' })
    const { ctx } = makeCtx()
    consumeShellPush(push({ open: true, url: 'https://other.test/', agentSessionId: 'sid-b', sessionId: 'sid-b' }), state, ctx)
    assert.equal(state.browserStates['sid-b'].url, 'https://other.test/')
    assert.equal(state.browserState.url, 'https://mine.test/')
    assert.equal(state.browserState.agentSessionId, 'sid-a')
  })

  console.log('test-browser-agent-reveal: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
