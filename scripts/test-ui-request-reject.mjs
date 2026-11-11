#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(resolve('node_modules/.inkstone-ui-request-reject-'))
try {
  const file = join(dir, 'ui.mjs')
  await build({
    stdin: { contents: "export * from './src/main/ui-requests'; export { consumeQuestionPush } from './src/renderer/src/state/push-consumers'; export { reduceSessionRuntime } from './src/renderer/src/state/session-runtime'", resolveDir: process.cwd() },
    outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent'
  })
  const { UiRequests, consumeQuestionPush, reduceSessionRuntime } = await import(pathToFileURL(file).href)
  let checks = 0
  const check = (condition, message) => { assert.ok(condition, message); checks += 1; console.log(`✓ ${message}`) }

  const events = []
  const ui = new UiRequests({ push: (event) => events.push(event), respondToPi: () => true })
  const ask = () => {
    const result = ui.requestHostUi({ method: 'input', title: 'q', message: 'm', timeout: 60_000 }).then(() => null, (error) => error)
    return { id: events.filter((e) => e.ch === 'ui-request').at(-1).payload.id, result }
  }
  const first = ask()
  const second = ask()
  ui.handleUi({ id: 'ext-1', method: 'select', title: '扩展提问', options: ['a'] })
  const requests = events.filter((e) => e.ch === 'ui-request').map((e) => e.payload)
  check(requests.length === 3 && ui.payloads.size === 3, '前置：三个待答提问')

  ui.rejectPendingHostUi('pi 已退出，问题请求已取消')
  const [errA, errB] = await Promise.all([first.result, second.result])
  check(errA instanceof Error && errB instanceof Error, '宿主提问被拒绝')
  const resolvedHost = events.filter((e) => e.ch === 'ui-resolved').map((e) => e.payload.id)
  check(resolvedHost.includes(first.id) && resolvedHost.includes(second.id), '每个宿主提问都推了 ui-resolved')
  check(!ui.payloads.has(first.id) && !ui.payloads.has(second.id) && ui.payloads.has('ext-1'), '宿主提问的 payload 已删除，扩展提问仍在')
  check(!ui.pendingUiRequests().some((q) => q.id === first.id), '恢复流程不再看到已拒绝提问')

  ui.discardPending()
  const resolvedAll = events.filter((e) => e.ch === 'ui-resolved').map((e) => e.payload.id)
  check(resolvedAll.includes('ext-1') && ui.payloads.size === 0 && ui.pending.size === 0, 'discardPending 对其余提问推 ui-resolved 并清空')
  check(resolvedAll.filter((id) => id === first.id).length === 1, '同一提问不重复推送')

  let patch = { uiRequests: requests }
  for (const event of events.filter((e) => e.ch === 'ui-resolved')) {
    consumeQuestionPush(event, patch, { set: (value) => { patch = { ...patch, ...value } } })
  }
  check(patch.uiRequests.length === 0, '渲染端收到后移除全部提问卡')
  let cache = {}
  const runtime = { sessionId: 'A', runId: 'rA', generation: 1 }
  for (const q of requests) cache = reduceSessionRuntime(cache, runtime, { ch: 'ui-request', payload: q })
  for (const event of events.filter((e) => e.ch === 'ui-resolved')) cache = reduceSessionRuntime(cache, runtime, event)
  check(cache.A.uiRequests.length === 0, '会话缓存里也没有幽灵提问')
  const agentSource = await readFile('src/main/agent.ts', 'utf8')
  check(!agentSource.includes('ui.pending.clear()') && agentSource.split('this.ui.discardPending()').length === 3, 'agent 退出与停止路径都经 discardPending 撤销提问')
  console.log(`ui-request-reject: ${checks} 项通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
