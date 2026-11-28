import './lib/test-isolate.mjs'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const nobleStub = { name: 'noble-stub', setup(b) {
  b.onResolve({ filter: /^@noble\/(curves|ciphers)\// }, (args) => ({ path: args.path, namespace: 'noble-stub' }))
  b.onLoad({ filter: /.*/, namespace: 'noble-stub' }, () => ({ contents: 'export const p256 = {}; export const gcm = () => ({})', loader: 'js' }))
} }

await runSuite(import.meta.url, async (ok) => {
  const built = await build({ stdin: { contents: `export * from './mobile/src/activity'; export { RemoteClient } from './mobile/src/api/client'; export { RelayTunnel } from './mobile/src/api/relay'`, resolveDir: '.', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [nobleStub] })
  const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

  let list = M.addNotice([], { id: 'a', level: 'info', message: '一', sessionId: 's-1' }, 1000)
  list = M.addNotice(list, { id: 'b', level: 'warning', message: '二' }, 2000)
  list = M.addNotice(list, { id: 'c', level: 'error', message: '三', sessionId: 's-2' }, 3000)
  list = M.addNotice(list, { id: 'a', level: 'info', message: '一（重复）', sessionId: 's-1' }, 4000)
  ok(list.length === 3 && list.at(-1).message === '一（重复）', '同 id 通知去重，保留最新')
  const forS1 = M.noticesFor(list, 's-1', 5000, new Set())
  ok(forS1.map((item) => item.id).join() === 'a,b', '会话页只显示本会话和无归属的通知，最新在前', forS1.map((item) => item.id).join())
  ok(M.noticesFor(list, 's-1', 5000, new Set(['a'])).map((item) => item.id).join() === 'b', '点掉的不再显示')
  ok(M.noticesFor(list, 's-1', 4000 + M.NOTICE_SHOW_MS, new Set()).length === 0, '超过显示时长自动消失')
  ok(M.addNotice(list, { id: 'd', level: 'info', message: '四' }, 100_000).length === 1, '过期通知不再保留')

  ok(M.quotaPercent({ used: 40, total: 100 }) === 40 && M.quotaPercent({ used: 5, total: 0 }) === null && M.quotaPercent({ used: 150, total: 100 }) === 100, '额度百分比限制在 0–100，总量为 0 时不显示')
  ok(/30 分钟/.test(M.resetText(30 * 60_000, 0)) && /2 小时/.test(M.resetText(125 * 60_000, 0)) && /3 天/.test(M.resetText(72 * 3600_000, 0)) && M.resetText(undefined, 0) === '', '重置时间文案')
  ok(M.jobStateText({ state: 'completed', exitCode: 0, live: false }) === '完成' && M.jobStateText({ state: 'exited', exitCode: 2, live: false }) === '退出码 2' && M.jobStateText({ state: 'running', live: true }) === '运行中', '后台任务状态文案')
  ok(M.jobStateText({ state: 'timeout', live: true }) === '超时仍在跑', '超时但仍在跑的任务如实标出')
  const wf = { status: 'running', waitingQuota: true, progress: { total: 10, done: 6, failed: 1, running: 2, queued: 1, stopped: 0 }, canPause: true, canResume: false, canStop: true }
  ok(M.workflowStatusText(wf) === '等额度' && M.workflowStatusText({ status: 'paused' }) === '已暂停', '工作流状态文案')
  ok(M.workflowProgressText(wf) === '6/10 完成 · 2 进行中 · 1 失败', '工作流进度文案')
  ok(M.workflowActions(wf).join() === 'pause,stop' && M.workflowActions({ canPause: false, canResume: true, canStop: true }).join() === 'resume,stop', '按状态给暂停、继续、停止')

  ok(M.jobStoppable({ live: true, state: 'running' }) && !M.jobStoppable({ live: true, state: 'stopping' }) && !M.jobStoppable({ live: false, state: 'completed' }), '只有仍在运行时给停止')
  const lines = M.patchLines('diff --git a/x b/x\r\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-旧\n+新\n 同\n')
  ok(lines.lines.map((line) => line.kind).join() === 'file,file,file,hunk,del,add,ctx' && !lines.clipped, '补丁按行着色分类')
  const many = M.patchLines(Array.from({ length: 10 }, (_, i) => `+${i}`).join('\n'), 4)
  ok(many.lines.length === 4 && many.clipped, '超过行数上限时截断并标出')
  ok(M.patchLines('+' + 'x'.repeat(1000)).lines[0].text.length === 401, '超长单行截断')
  const realFetch = globalThis.fetch
  M.RelayTunnel.for = () => ({ request: async (method, path, init) => { const response = await globalThis.fetch(`relay://pc${path}`, { method, headers: init.headers, body: init.body }); return { status: response.status, text: await response.text() } } })
  const seen = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}')
    seen.push({ url, method: init.method ?? 'GET', key: init.headers['idempotency-key'], body, version: init.headers['x-yan-remote-version'] })
    const data = url.endsWith('/session.jobs') ? { jobs: [{ id: 'j1' }] } : url.endsWith('/session.workflows') ? { runs: [{ id: 'wf-0000000a' }] } : url.endsWith('/usage') ? { range: body.range } : { cards: [], checkedAt: 1 }
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const client = new M.RemoteClient({ baseUrl: 'relay://pc', relay: { join: 'wss://relay', hostKey: 'h', clientKey: 'c' }, token: 't', deviceId: 'd' })
    ok((await client.jobs('s 1'))[0].id === 'j1' && seen[0].url.endsWith('/remote/v1/call/session.jobs') && seen[0].body.sessionId === 's 1' && seen[0].method === 'POST' && /^\d+$/.test(seen[0].version), '读取后台任务，带协议版本')
    ok((await client.workflows('s-1'))[0].id === 'wf-0000000a', '读取工作流')
    await client.workflowControl('s-1', 'wf-0000000a', 'pause')
    ok(seen[2].method === 'POST' && seen[2].url.endsWith('/workflow.control') && seen[2].body.workflowId === 'wf-0000000a' && seen[2].body.action === 'pause' && /^m-/.test(seen[2].key), '工作流控制带幂等键')
    await client.stopJob('s-1', 'term-job-a-1')
    ok(seen[3].method === 'POST' && seen[3].url.endsWith('/job.stop') && seen[3].body.jobId === 'term-job-a-1' && /^m-/.test(seen[3].key), '停止后台任务带幂等键')
    await client.subagentPatch('s-1', 'sub-a')
    ok(seen[4].url.endsWith('/subagent.patch') && seen[4].body.runId === 'sub-a' && !seen[4].key, '读取子代理补丁不带幂等键')
    seen.splice(3, 2)
    ok((await client.quota()).checkedAt === 1 && (await client.usage('30d')).range === '30d' && seen[4].url.endsWith('/usage') && seen[4].body.range === '30d', '读取额度与用量')
  } finally {
    globalThis.fetch = realFetch
  }
})
