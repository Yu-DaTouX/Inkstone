import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'yan-notice-store-'))
process.env.YAN_DATA_DIR = join(work, 'data')
process.env.YAN_PI_DIR = join(work, 'pi')
let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
  console.log(`✓ ${message}`)
}

try {
  const outfile = join(work, 'notify.mjs')
  await build({
    stdin: {
      contents: `
        export { createSubagentNotifier, markSubagentResultRead, NOTICE_COALESCE_WINDOW_MS } from './src/main/subagent-notify'
        export { createSubagentNoticeStore } from './src/main/subagent-notice-store'
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const { createSubagentNotifier, markSubagentResultRead, NOTICE_COALESCE_WINDOW_MS, createSubagentNoticeStore } = await import(pathToFileURL(outfile).href)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const file = join(work, 'subagent-notices.json')
  const finished = (id, over = {}) => ({
    id, task: `任务 ${id}`, status: 'error', error: '额度用尽', isolation: 'shared-cwd', parentSessionId: 'sess-1',
    startedAt: Date.now() - 5_000, endedAt: Date.now() - 1_000, review: 'none', transcript: [{ id: 'm1', role: 'assistant', text: 'x'.repeat(500) }], ...over
  })

  const store = createSubagentNoticeStore(file)
  const first = createSubagentNotifier({ enabled: () => true, find: () => null, runningSiblings: () => 0, store })
  first(finished('sub-aaaa0001'))
  first(finished('sub-aaaa0002'))
  await sleep(NOTICE_COALESCE_WINDOW_MS + 600)
  check(existsSync(file), '找不到父会话时，未投递的通知写盘')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  check(saved.state['sess-1']?.map((run) => run.id).join() === 'sub-aaaa0001,sub-aaaa0002', '按父会话保存未投递的运行')
  check(saved.state['sess-1'].every((run) => run.transcript.length === 0), '落盘时不带转录')

  const sent = []
  const target = { send: async (text) => { sent.push(text); return { ok: true } } }
  markSubagentResultRead('sub-aaaa0002', finished('x').endedAt)
  const restarted = createSubagentNotifier({ enabled: () => true, find: () => target, runningSiblings: () => 0, store: createSubagentNoticeStore(file) })
  restarted.retry()
  await sleep(300)
  check(sent.length === 1, '重启后一次性重投')
  check(sent[0].includes('sub-aaaa0001'), '重启后重投未读的通知')
  check(JSON.parse(readFileSync(file, 'utf8')).state['sess-1'] === undefined, '投递成功后清掉落盘记录')

  const again = createSubagentNotifier({ enabled: () => true, find: () => target, runningSiblings: () => 0, store: createSubagentNoticeStore(file) })
  again.retry()
  await sleep(200)
  check(sent.length === 1, '已投递的不会在下一次重启时再投')

  const stale = createSubagentNoticeStore(join(work, 'stale.json'), () => Date.now() + 8 * 24 * 60 * 60 * 1000)
  stale.save({ k: [finished('sub-bbbb0001')] })
  check(Object.keys(stale.load()).length === 0, '超过 7 天的通知不再重投')

  const queued = []
  const later = createSubagentNotifier({
    enabled: () => true, runningSiblings: () => 0,
    find: () => null,
    store: { load: () => ({}), save: (state) => queued.push(state) }
  })
  later(finished('sub-cccc0001', { endedAt: 123_456 }))
  await sleep(NOTICE_COALESCE_WINDOW_MS + 600)
  check(queued.at(-1)?.['sess-1']?.length === 1, '内存里等着重投的通知同步到存储')
  markSubagentResultRead('sub-cccc0001', 123_456)
  check(Object.keys(queued.at(-1)).length === 0, '主 agent 读过结果后，等着重投的通知被撤销')

  const readBeforeRetry = []
  markSubagentResultRead('sub-dddd0001', 777)
  const racing = createSubagentNotifier({
    enabled: () => true, runningSiblings: () => 0,
    find: (() => { let ready = false; const f = () => (ready ? { send: async (text) => { readBeforeRetry.push(text); return { ok: true } } } : null); f.open = () => { ready = true }; return f })(),
    store: { load: () => ({ 'sess-1': [finished('sub-dddd0001', { endedAt: 777 })] }), save: () => {} }
  })
  racing.retry()
  await sleep(200)
  check(readBeforeRetry.length === 0, '重投前已被读过的结果不再重复通知')

  const busyState = { running: true }
  const busySent = []
  const busy = createSubagentNotifier({
    enabled: () => true, runningSiblings: () => 0,
    find: () => ({ send: async (text) => { busySent.push(text); return { ok: true } }, getState: () => ({ isAgentRunning: busyState.running }) }),
    store: { load: () => ({ 'sess-1': [finished('sub-eeee0001', { endedAt: 888 })] }), save: () => {} }
  })
  busy.retry()
  await sleep(200)
  check(busySent.length === 0, '父会话正忙时重投等它空闲')
  busyState.running = false
  busy.retry()
  await sleep(200)
  check(busySent.length === 1, '空闲后重投')


  const giveUpStates = []
  const failing = createSubagentNotifier({
    enabled: () => true, runningSiblings: () => 0,
    find: () => ({ send: async () => ({ ok: false, error: '拒收' }) }),
    store: { load: () => ({ 'sess-9': [finished('sub-ffff0001', { parentSessionId: 'sess-9', endedAt: 999 })] }), save: (state) => giveUpStates.push(structuredClone(state)) }
  })
  for (let i = 0; i < 6; i++) {
    failing.retry()
    await sleep(120)
  }
  check(giveUpStates.length > 0 && giveUpStates.at(-1)['sess-9'] === undefined, '连续投递失败放弃后，落盘记录同步清掉，重启不再冒出幽灵通知')

  const staleSent = []
  const gate = { release: undefined }
  const slowTarget = { send: async (text) => { await new Promise((resolve) => { gate.release = resolve }); staleSent.push(text); return { ok: true } } }
  const fastTarget = { send: async (text) => { staleSent.push(text); return { ok: true } } }
  const stateOf = { k1: [finished('sub-gggg0001', { parentSessionId: 'k1', endedAt: 1001 })], k2: [finished('sub-gggg0002', { parentSessionId: 'k2', endedAt: 1002 })] }
  const dup = createSubagentNotifier({
    enabled: () => true, runningSiblings: () => 0,
    find: (run) => (run.parentSessionId === 'k1' ? slowTarget : fastTarget),
    store: { load: () => structuredClone(stateOf), save: () => {} }
  })
  dup.retry()
  await sleep(100)
  dup(finished('sub-gggg0003', { parentSessionId: 'k2', endedAt: 1003 }))
  await sleep(NOTICE_COALESCE_WINDOW_MS + 600)
  gate.release?.()
  await sleep(300)
  const mentions = staleSent.filter((text) => text.includes('sub-gggg0002')).length
  check(mentions === 1, `retry 的旧快照不会让同一条通知重复投递（实际 ${mentions} 次）`)

  console.log(`Subagent notice persistence: ${checks} passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
