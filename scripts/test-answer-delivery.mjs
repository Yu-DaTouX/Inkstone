import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const calls = { approvals: [], respond: [], abortRetry: 0, quota: 0 }
const host = {
  pending: [],
  answerThrows: false,
  answerOk: true,
  respondResult: { ok: true },
  respondThrows: false,
  windows: []
}

globalThis.window = {
  yan: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'pendingApprovals') return async () => host.pending
        if (prop === 'answerApproval') {
          return async (id) => {
            calls.approvals.push(id)
            if (host.answerThrows) throw new Error('ipc broke')
            return { ok: host.answerOk }
          }
        }
        if (prop === 'respondUi') {
          return async (res) => {
            calls.respond.push(res)
            if (host.respondThrows) throw new Error('ipc broke')
            return host.respondResult
          }
        }
        if (prop === 'providerQuota') {
          return async () => {
            calls.quota += 1
            return { supported: true, windows: host.windows }
          }
        }
        if (prop === 'abortRetry') {
          return async () => {
            calls.abortRetry += 1
            return { ok: true }
          }
        }
        return async () => undefined
      }
    }
  ),
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://localhost/' }
}
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {}
}
globalThis.requestAnimationFrame = (fn) => {
  fn(0)
  return 0
}
globalThis.cancelAnimationFrame = () => {}
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
  hasFocus: () => true,
  querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
}

const temp = await mkdtemp(join(tmpdir(), 'yan-answer-delivery-'))
const outfile = join(temp, 'store.mjs')
await build({
  entryPoints: ['src/renderer/src/state/store.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    requestAnimationFrame: 'globalThis.requestAnimationFrame',
    cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
  }
})
const { useStore } = await import(pathToFileURL(outfile).href)

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const approval = (id, createdAt) => ({ id, createdAt, kind: 'tool', sessionId: 's1', title: id, detail: '', choices: ['once', 'deny'] })
const reset = (overrides = {}) =>
  useStore.setState({
    approvals: [],
    notices: [],
    uiRequests: [],
    uiDrafts: {},
    session: null,
    peekedSessionId: null,
    peekedPath: null,
    activeRunnerId: null,
    sessionRuntimes: {},
    quotaResume: null,
    ...overrides
  })

console.log('▌C1 审批答复：异常/拒收时核对恢复且不重复批准')
{
  reset({ approvals: [approval('a1', 1), approval('a2', 2)] })
  host.pending = [approval('a1', 1), approval('a2', 2)]
  host.answerThrows = true
  calls.approvals = []
  const result = await useStore.getState().answerApproval('a1', 'once')
  ok(result === false, '抛错返回失败')
  ok(calls.approvals.length === 1, '只投递一次，不自动重批', calls.approvals)
  const ids = useStore.getState().approvals.map((item) => item.id)
  ok(ids.includes('a1'), '主进程仍待批准时恢复卡片', ids)
  ok(useStore.getState().notices.some((notice) => notice.type === 'error'), '显示未送达提示')

  host.answerThrows = false
  host.answerOk = false
  host.pending = []
  calls.approvals = []
  reset({ approvals: [approval('a1', 1)] })
  const rejected = await useStore.getState().answerApproval('a1', 'once')
  ok(rejected === false && calls.approvals.length === 1, '主进程拒收时不重试')
  ok(useStore.getState().approvals.length === 0, '已不在待审批列表时不盲目恢复卡片')

  host.answerOk = true
  reset({ approvals: [approval('a1', 1)] })
  const accepted = await useStore.getState().answerApproval('a1', 'once')
  ok(accepted === true && useStore.getState().approvals.length === 0, '正常送达后移除卡片')
}

console.log('▌C2 提问答复：结果与失败保留')
{
  const request = { id: 'q1', method: 'select', message: 'pick', options: ['a'] }
  reset({ uiRequests: [request], uiDrafts: { q1: 'answer text' } })
  host.respondResult = { ok: false, error: 'not delivered' }
  calls.respond = []
  const failed = await useStore.getState().answerUi({ id: 'q1', value: 'a' })
  ok(failed === false, '未送达返回失败')
  ok(calls.respond.length === 1 && calls.respond[0].id === 'q1', '只发送一次', calls.respond)
  ok(useStore.getState().uiRequests.some((item) => item.id === 'q1'), '失败保留问题卡片')
  ok(useStore.getState().uiDrafts.q1 === 'answer text', '失败保留用户答复')
  ok(useStore.getState().notices.some((notice) => notice.type === 'error'), '失败显示提示')

  host.respondThrows = true
  reset({ uiRequests: [request], uiDrafts: { q1: 'answer text' } })
  const thrown = await useStore.getState().answerUi({ id: 'q1', value: 'a' })
  ok(thrown === false && useStore.getState().uiRequests.some((item) => item.id === 'q1'), 'IPC 抛错也保留卡片与答复')

  host.respondThrows = false
  host.respondResult = { ok: true }
  reset({ uiRequests: [request], uiDrafts: { q1: 'answer text' } })
  const delivered = await useStore.getState().answerUi({ id: 'q1', value: 'a' })
  ok(delivered === true, '送达返回成功')
  ok(useStore.getState().uiRequests.length === 0 && !('q1' in useStore.getState().uiDrafts), '送达后清除卡片与答复')
}

console.log('▌A2 主会话额度等待：推送不自动武装，手动开启可用')
{
  const blocked = [{ label: '5h', total: 100, used: 100, exceeded: true, resetAt: Date.now() + 3_600_000 }]
  reset({
    session: { sessionId: 's1', model: { provider: 'p', id: 'm' } },
    activeRunnerId: 'r1',
    runners: [{ id: 'r1', runId: 'r1', sessionId: 's1', sessionFile: 'C:/s/s1.jsonl', generation: 1, running: false }]
  })
  host.windows = blocked
  calls.quota = 0
  calls.abortRetry = 0
  useStore.getState().applyPush({ ch: 'quota-wait', payload: {} })
  ok(useStore.getState().quotaResume === null && calls.quota === 0, '额度等待推送不再自动武装')

  useStore.getState().applyPush({ ch: 'quota-wait', payload: { ifWindowFull: true } })
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  ok(useStore.getState().quotaResume === null, '窗口满也保持手动开启')
  ok(calls.abortRetry === 1, '窗口满时停止自动重试', calls.abortRetry)

  calls.quota = 0
  host.windows = blocked
  const armed = await useStore.getState().armQuotaResume()
  ok(armed === true && !!useStore.getState().quotaResume, '手动点等待才武装')
  useStore.getState().cancelQuotaResume()
  ok(useStore.getState().quotaResume === null, '取消后清空等待')
}

console.log(`答复送达、手动额度等待：${pass} 项通过`)
