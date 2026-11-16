import { runSuite } from './lib/test-suite.mjs'

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const shell = { openPath: async () => "" }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const BrowserWindow = class {}',
        'export const ipcMain = { handle: () => undefined }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const session = { defaultSession: {}, fromPartition: () => ({}) }',
        'export default {}'
      ].join('\n')
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const host = await compile('src/main/remote-host.ts', { plugins: [electronStub], external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] })
  const { RemoteServer, parseRemoteQueueOp } = await compile('src/main/remote-server.ts')

  const NOTICE = '<subagent-notification id="sub-a" status="done">\n结果\n这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。'
  const longText = 'x'.repeat(600)
  let state = {
    steering: [{ id: 'q-1', text: '先看测试' }],
    followUp: [
      { id: 'q-2', text: NOTICE },
      { id: 'q-3', text: longText },
      { id: 'q-4', text: '', images: [{ data: 'AAAA', mimeType: 'image/png' }] }
    ]
  }
  const digest = host.queueTextDigest
  const queue = host.remoteQueueOf({ steering: ['先看测试'], followUp: [] }, state, host.queueItemHidden, digest)
  ok(queue.items.steering[0].id === 'q-1' && queue.steering[0] === '先看测试', '有运行实例时排队消息带 id，旧字段 steering/followUp 照旧给旧版手机', JSON.stringify(queue.items.steering))
  ok(queue.items.steering[0].digest === digest('先看测试') && /^[0-9a-f]{64}$/.test(queue.items.steering[0].digest), '每条带原文哈希')
  ok(!queue.items.followUp.some((item) => item.id === 'q-2') && !queue.followUp.some((text) => text.startsWith('<subagent-notification')), '子代理通知不当排队消息，也不暴露 id')
  ok(queue.items.followUp[0].text.length === 501 && queue.items.followUp[0].digest === digest(longText), '长消息显示截断，哈希按原文')
  ok(queue.items.followUp[1].images === 1 && !('data' in queue.items.followUp[1]), '只有图片的排队消息给张数，不带图片数据')
  ok(host.remoteQueueOf(null, { steering: [], followUp: [] }) === undefined, '空队列不带字段')
  ok(host.remoteQueueOf({ steering: ['a'], followUp: [] }).items === undefined, '没有条目状态时仍是旧格式')

  const calls = []
  const lockedState = () => state
  const agent = {
    removeQueued: async (id, guard) => { const refused = guard(lockedState()); calls.push(['remove', id, refused]); return refused ? { ok: false, error: refused } : { ok: true } },
    steerQueued: async (id, guard) => { const refused = guard(lockedState()); calls.push(['steer', id, refused]); return refused ? { ok: false, error: refused } : { ok: true } },
    planQueue: async (plan) => { const planned = plan(lockedState()); calls.push(['plan', planned]); return 'error' in planned ? { ok: false, error: planned.error } : { ok: true } }
  }
  const stale = await host.applyRemoteQueueOp(agent, { op: 'remove', id: 'q-1', expect: digest('别的内容') })
  ok(!stale.ok && stale.status === 409 && stale.code === 'queue_changed' && calls.at(-1)[2], '手机看到的内容和电脑上的不一致时拒绝', JSON.stringify(stale))
  const hidden = await host.applyRemoteQueueOp(agent, { op: 'remove', id: 'q-2', expect: digest(NOTICE) })
  ok(!hidden.ok && calls.at(-1)[2], '不能经远程撤回子代理通知，哈希对上也不行')
  const removed = await host.applyRemoteQueueOp(agent, { op: 'remove', id: 'q-1', expect: digest('先看测试') })
  ok(removed.ok && calls.at(-1)[0] === 'remove' && calls.at(-1)[2] === null, '撤回走 removeQueued，并在队列锁内核对')
  const tailChanged = await host.applyRemoteQueueOp(agent, { op: 'steer', id: 'q-3', expect: digest(`${'x'.repeat(500)}y`) })
  ok(!tailChanged.ok, '第 500 字以后不同也能发现')
  const steered = await host.applyRemoteQueueOp(agent, { op: 'steer', id: 'q-3', expect: digest(longText) })
  ok(steered.ok && calls.at(-1)[0] === 'steer', '原文哈希一致时可立即插话')

  const seen = digest('先看测试')
  const racing = { ...agent, removeQueued: async (id, guard) => {
    state = { ...state, steering: [{ id: 'q-1', text: '桌面刚改成别的' }] }
    return agent.removeQueued(id, guard)
  } }
  const raced = await host.applyRemoteQueueOp(racing, { op: 'remove', id: 'q-1', expect: seen })
  ok(!raced.ok && raced.code === 'queue_changed', '桌面在手机请求排队期间改了同一条：拿到锁时再核对，拒绝')
  state = { ...state, steering: [{ id: 'q-1', text: '先看测试' }] }

  const edited = await host.applyRemoteQueueOp(agent, { op: 'edit', id: 'q-1', expect: seen, text: '先跑测试' })
  const plannedEdit = calls.at(-1)[1]
  ok(edited.ok && plannedEdit.next.steering[0].text === '先跑测试' && plannedEdit.next.followUp.length === 3, '编辑在锁内核对后改写这一条，其余不动')
  const editStale = await host.applyRemoteQueueOp(agent, { op: 'edit', id: 'q-1', expect: digest('旧'), text: '新' })
  ok(!editStale.ok && 'error' in calls.at(-1)[1], '编辑时内容已变则拒绝')

  const withdraw = await host.applyRemoteQueueOp(agent, { op: 'clear', items: [{ id: 'q-1', expect: seen }, { id: 'q-3', expect: digest(longText) }] })
  const plannedClear = calls.at(-1)[1]
  ok(withdraw.ok && withdraw.data.count === 2, '全部撤回只撤手机列出的条目')
  ok(plannedClear.next.steering.length === 0 && plannedClear.next.followUp.map((item) => item.id).join() === 'q-2,q-4', '子代理通知和手机没列出的条目保留', JSON.stringify(plannedClear.next))
  const withdrawStale = await host.applyRemoteQueueOp(agent, { op: 'clear', items: [{ id: 'q-1', expect: seen }, { id: 'q-9', expect: seen }] })
  ok(!withdrawStale.ok && withdrawStale.code === 'queue_changed', '列出的条目有一条已不在就整体拒绝')
  const withdrawNotice = host.planRemoteWithdraw(state, [{ id: 'q-2', expect: digest(NOTICE) }])
  ok('error' in withdrawNotice, '撤回列表里带子代理通知时拒绝')
  const none = await host.applyRemoteQueueOp(null, { op: 'clear', items: [{ id: 'q-1', expect: seen }] })
  ok(!none.ok && none.code === 'queue_changed', '没有运行实例时返回 409')

  const hex = 'a'.repeat(64)
  ok(parseRemoteQueueOp({ op: 'remove', id: 'q-1', expect: hex })?.op === 'remove', '合法撤回请求能解析')
  ok(parseRemoteQueueOp({ op: 'remove', id: '../x', expect: hex }) === null, '非法 id 拒绝')
  ok(parseRemoteQueueOp({ op: 'remove', id: 'q-1', expect: '先看测试' }) === null, 'expect 必须是哈希')
  ok(parseRemoteQueueOp({ op: 'edit', id: 'q-1', expect: hex, text: '   ' }) === null, '编辑成空白拒绝')
  ok(parseRemoteQueueOp({ op: 'move', id: 'q-1', expect: hex, direction: 'up' }) === null, '不支持的操作拒绝')
  ok(parseRemoteQueueOp({ op: 'clear' }) === null, '不带条目的清空拒绝（不允许清掉看不到的项）')
  ok(parseRemoteQueueOp({ op: 'clear', items: [{ id: 'q-1', expect: hex }] })?.items.length === 1, '带条目的撤回能解析')
  ok(parseRemoteQueueOp({ op: 'clear', items: Array.from({ length: 41 }, (_, i) => ({ id: `q-${i}`, expect: hex })) }) === null, '撤回条目最多 40 条')

  const run = (over = {}) => ({ id: 'sub-1', task: '修 bug', status: 'done', isolation: 'worktree', startedAt: 1, endedAt: 2, transcript: [], review: 'pending', parentSessionId: 's-1', diff: { files: 2, additions: 5, deletions: 1, paths: ['src/a.ts', 'src/b.ts'], truncated: false, patchPath: 'C:/Users/u/.yan/sub-1.patch' }, ...over })
  const shown = host.remoteSubagentRun(run())
  ok(shown.review === 'pending' && shown.canMerge === true && shown.canDiscard === true && shown.diff.files === 2, '待处置的工作树子代理带改动摘要和可合并、可放弃标记', JSON.stringify(shown))
  ok(!JSON.stringify(shown).includes('.patch'), '不把补丁的本机路径发给手机')
  const shared = host.remoteSubagentRun(run({ isolation: 'shared-cwd', review: 'none', diff: undefined }))
  ok(!('review' in shared) && !('canMerge' in shared), '共享目录的子代理不带处置字段')
  const many = host.remoteSubagentRun(run({ diff: { files: 30, additions: 1, deletions: 1, paths: Array.from({ length: 30 }, (_, i) => `f${i}`), truncated: false, patchPath: 'p' } }))
  ok(many.diff.paths.length === 20 && many.diff.truncated === true, '文件列表最多 20 条并标记截断')

  const acted = []
  const act = async (id) => { acted.push(id); return { ok: true, warning: '工作树 C:\\Users\\u\\wt 已保留' } }
  const merged = await host.remoteReviewSubagent('s-1', 'sub-1', 'merge', [run()], act)
  ok(merged.ok && merged.data.review === 'merged' && !merged.data.warning.includes('C:\\Users'), '合并成功，提示里的本机路径被遮掉', JSON.stringify(merged))
  const otherSession = await host.remoteReviewSubagent('s-2', 'sub-1', 'merge', [run()], act)
  ok(!otherSession.ok && otherSession.status === 404 && acted.length === 1, '不能处置别的会话的子代理')
  const running = await host.remoteReviewSubagent('s-1', 'sub-1', 'discard', [run({ status: 'running' })], act)
  ok(!running.ok && running.status === 409 && acted.length === 1, '运行中的子代理不能放弃')
  const noPatch = await host.remoteReviewSubagent('s-1', 'sub-1', 'merge', [run({ diff: undefined })], act)
  ok(!noPatch.ok && acted.length === 1, '没有补丁时不能合并')
  const discarded = await host.remoteReviewSubagent('s-1', 'sub-1', 'discard', [run({ diff: undefined })], async () => ({ ok: true }))
  ok(discarded.ok && discarded.data.review === 'discarded', '没有补丁时仍可放弃工作树')
  const kept = await host.remoteReviewSubagent('s-1', 'sub-1', 'discard', [run()], async () => ({ ok: false, error: '工作树已保留。先把这些路径和大小告诉用户，才用 yan subagent discard --id sub-1 --drop-outputs' }))
  ok(!kept.ok && kept.code === 'subagent_outputs_kept' && !kept.error.includes('--drop-outputs') && kept.error.includes('电脑上'), '产物超限放弃失败时，手机上提示到电脑处理，不给命令行参数', kept.error)

  const sent = []
  const sendFn = async (id, text) => { sent.push([id, text]); return { ok: true, delivery: 'resumed' } }
  const resumed = await host.remoteSendSubagent('s-1', 'sub-1', '继续', [run({ status: 'cancelled', endReason: 'interrupted', resumable: { ok: true } })], sendFn)
  ok(resumed.ok && resumed.data.delivery === 'resumed' && sent[0][1] === '继续', '中断可续接的子代理能从手机续接')
  const blocked = await host.remoteSendSubagent('s-1', 'sub-1', '继续', [run({ status: 'cancelled', endReason: 'interrupted', resumable: { ok: false } })], sendFn)
  ok(!blocked.ok && blocked.code === 'subagent_not_resumable' && sent.length === 1, '不能续接的不再转发')
  const foreign = await host.remoteSendSubagent('s-9', 'sub-1', '继续', [run()], sendFn)
  ok(!foreign.ok && foreign.status === 404 && sent.length === 1, '不能给别的会话的子代理发消息')

  const httpCalls = []
  const phone = { id: 'd-phone', name: '手机', kind: 'phone', createdAt: 0, lastSeenAt: null }
  const server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    token: 'legacy-remote-token-1234567890',
    devices: { authenticate: async (token) => (token === 'phone-device-token-123456' ? phone : null) },
    handlers: {
      async snapshot() { return { sessions: [] } },
      async history() { return { ok: true, data: { messages: [] } } },
      async command() { return { ok: true } },
      async queue(sessionId, op) { httpCalls.push(['queue', sessionId, op]); return { ok: true, data: op } },
      async reviewSubagent(sessionId, runId, action) { httpCalls.push(['review', sessionId, runId, action]); return { ok: true, data: { id: runId, review: action } } },
      async sendSubagent(sessionId, runId, text) { httpCalls.push(['send', sessionId, runId, text]); return { ok: true, data: { id: runId } } }
    }
  })
  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  let keySeq = 0
  const post = async (path, body, token, key = `test-key-${++keySeq}-abcdef`) => {
    const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const getInfo = async (token) => (await (await fetch(`${base}/remote/v1/info`, { headers: { authorization: `Bearer ${token}` } })).json()).capabilities
  try {
    const phoneCaps = await getInfo('phone-device-token-123456')
    ok(phoneCaps.includes('queue-edit') && phoneCaps.includes('subagent-review') && phoneCaps.includes('subagent-send'), '配对手机能看到新能力', JSON.stringify(phoneCaps))
    const legacyCaps = await getInfo('legacy-remote-token-1234567890')
    ok(legacyCaps.includes('queue-edit') && !legacyCaps.includes('subagent-review'), '非配对手机的令牌拿不到合并放弃能力')

    const queued = await post('/remote/v1/sessions/s-1/queue', { op: 'steer', id: 'q-3', expect: 'b'.repeat(64) }, 'phone-device-token-123456')
    ok(queued.status === 200 && httpCalls.at(-1)[0] === 'queue' && httpCalls.at(-1)[2].op === 'steer', '排队操作路由到处理器')
    const noKey = await post('/remote/v1/sessions/s-1/queue', { op: 'clear', items: [{ id: 'q-1', expect: 'b'.repeat(64) }] }, 'phone-device-token-123456', '')
    ok(noKey.status === 400 && noKey.body.code === 'idempotency_key_required', '排队操作必须带幂等键')
    const badOp = await post('/remote/v1/sessions/s-1/queue', { op: 'remove', id: 'q-1' }, 'phone-device-token-123456')
    ok(badOp.status === 400, '缺 expect 的排队操作返回 400')

    const before = httpCalls.length
    const legacyMerge = await post('/remote/v1/sessions/s-1/subagents/sub-1/merge', { confirm: true }, 'legacy-remote-token-1234567890')
    ok(legacyMerge.status === 403 && legacyMerge.body.code === 'paired_user_required' && httpCalls.length === before, '合并需要配对的手机')
    const unconfirmed = await post('/remote/v1/sessions/s-1/subagents/sub-1/discard', {}, 'phone-device-token-123456')
    ok(unconfirmed.status === 400 && httpCalls.length === before, '放弃需要明确确认')
    const discard = await post('/remote/v1/sessions/s-1/subagents/sub-1/discard', { confirm: true }, 'phone-device-token-123456')
    ok(discard.status === 200 && httpCalls.at(-1)[3] === 'discard', '确认后放弃路由到处理器')
    const badRun = await post('/remote/v1/sessions/s-1/subagents/..%2Fx/merge', { confirm: true }, 'phone-device-token-123456')
    ok(badRun.status === 400, '子代理 id 不合法时拒绝')
    const message = await post('/remote/v1/sessions/s-1/subagents/sub-1/send', { text: '继续改' }, 'phone-device-token-123456')
    ok(message.status === 200 && httpCalls.at(-1)[0] === 'send' && httpCalls.at(-1)[3] === '继续改', '给子代理发消息路由到处理器')
    const empty = await post('/remote/v1/sessions/s-1/subagents/sub-1/send', { text: '  ' }, 'phone-device-token-123456')
    ok(empty.status === 400, '空消息拒绝')
    const stopStill = await post('/remote/v1/sessions/s-1/subagents/sub-1/stop', {}, 'phone-device-token-123456')
    ok(stopStill.status === 404, '原有停止路由不受影响（未配置处理器时仍提示更新）')
  } finally {
    await server.stop()
  }
})
