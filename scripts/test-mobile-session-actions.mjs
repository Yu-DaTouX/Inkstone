import './lib/test-isolate.mjs'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const nobleStub = { name: 'noble-stub', setup(b) {
  b.onResolve({ filter: /^@noble\/(curves|ciphers)\// }, (args) => ({ path: args.path, namespace: 'noble-stub' }))
  b.onLoad({ filter: /.*/, namespace: 'noble-stub' }, () => ({ contents: 'export const p256 = {}; export const gcm = () => ({})', loader: 'js' }))
} }

await runSuite(import.meta.url, async (ok) => {
  const built = await build({ stdin: { contents: `export * from './mobile/src/sessionActions'; export { RemoteClient } from './mobile/src/api/client'`, resolveDir: '.', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [nobleStub] })
  const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

  const legacy = M.queuedRows({ steering: ['插一句'], followUp: ['之后做'] })
  ok(legacy.length === 2 && legacy.every((row) => !row.id), '旧版电脑只给文本时照旧显示，没有 id')
  ok(legacy.every((row) => M.queueRowActions(row, true).length === 0), '旧版电脑的排队行不给操作')
  const notice = '<subagent-notification id="sub-a" status="done">\n结果\n这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。'
  ok(M.queuedRows({ steering: [], followUp: [notice, '真消息'] }).map((row) => row.text).join() === '真消息', '旧版电脑下发的宿主通知不当排队消息显示')
  ok(M.queuedRows({ steering: [], followUp: [], items: { steering: [], followUp: [{ id: 'q-9', text: notice, digest: '9'.repeat(64) }] } }).length === 0, '条目里的宿主通知也不显示、不给操作')
  const d1 = '1'.repeat(64), d2 = '2'.repeat(64)
  const rows = M.queuedRows({ steering: ['插一句'], followUp: ['之后做'], items: { steering: [{ id: 'q-1', text: '插一句', digest: d1 }], followUp: [{ id: 'q-2', text: '之后做', digest: d2, images: 2 }] } })
  ok(rows[0].id === 'q-1' && rows[0].digest === d1 && rows[0].kind === 'steer' && rows[1].kind === 'queue' && rows[1].images === 2, '新版电脑给条目时带 id、哈希与图片张数')
  ok(M.queueRowActions(rows[1], true).join() === 'steer,edit,remove', '排队消息可立即插话、编辑、撤回')
  ok(M.queueRowActions(rows[0], true).join() === 'edit,remove', '已是插话的只给编辑与撤回')
  ok(M.queueRowActions(rows[1], false).length === 0, '电脑不支持 queue-edit 时不给操作')
  ok(M.queueRowActions({ ...rows[1], digest: undefined }, true).length === 0, '没有哈希的条目不给操作')
  const remove = M.queueOp(rows[1], 'remove')
  ok(remove.op === 'remove' && remove.id === 'q-2' && remove.expect === d2, '撤回带上原文哈希供电脑核对')
  ok(M.queueOp(rows[1], 'edit', '  之后做 ') === null, '内容没变时不发编辑')
  const edit = M.queueOp(rows[1], 'edit', ' 改成这样 ')
  ok(edit.op === 'edit' && edit.text === '改成这样' && edit.expect === d2, '编辑带新文本与原文哈希')
  const all = M.withdrawAllOp([...rows, { kind: 'queue', text: '旧格式' }])
  ok(all.op === 'clear' && all.items.map((item) => item.id).join() === 'q-1,q-2' && all.items[1].expect === d2, '全部撤回只列手机看到且可核对的条目')
  ok(M.withdrawAllOp(legacy) === null, '旧版电脑没有条目时不给全部撤回')

  ok(M.composerSendPlan({ running: false, compacting: false, choice: 'followUp' }).mode === undefined, '空闲时直接发送，不带模式')
  ok(M.composerSendPlan({ running: true, compacting: false, choice: 'steer' }).mode === 'steer', '运行中默认插话')
  ok(M.composerSendPlan({ running: true, compacting: false, choice: 'followUp' }).mode === 'followUp', '运行中可选排队到本轮之后')
  ok(M.composerSendPlan({ running: true, compacting: true, choice: 'steer' }).action === 'hold', '压缩中先暂存，压缩完再发')
  ok(M.composerSendPlan({ running: false, compacting: true, choice: 'steer' }).action === 'hold', '手动压缩时也暂存')

  const caps = { review: true, send: true }
  const pending = M.subagentActions({ status: 'done', review: 'pending', canMerge: true, canDiscard: true }, caps)
  ok(pending.merge && pending.discard && pending.send, '待处置的子代理可合并、放弃、发消息让它继续改')
  const live = M.subagentActions({ status: 'running', review: 'pending', canMerge: true, canDiscard: true }, caps)
  ok(!live.merge && !live.discard && live.send, '运行中的子代理不给合并放弃，可补充指令')
  const blocked = M.subagentActions({ status: 'cancelled', endReason: 'interrupted', resumable: false }, caps)
  ok(!blocked.send, '不能续接的中断子代理不给发消息')
  const resumable = M.subagentActions({ status: 'cancelled', endReason: 'interrupted', resumable: true }, caps)
  ok(resumable.send && !resumable.merge, '可续接的中断子代理能发消息续接')
  const old = M.subagentActions({ status: 'done', review: 'pending', canMerge: true, canDiscard: true }, { review: false, send: false })
  ok(!old.merge && !old.discard && !old.send, '旧版电脑不支持时不显示新按钮')
  const merged = M.subagentActions({ status: 'done', review: 'merged' }, caps)
  ok(!merged.merge && !merged.discard && !merged.send, '已合并的不再给处置按钮')

  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body ?? 'null'), key: init.headers['idempotency-key'] })
    return new Response(JSON.stringify({ ok: true, data: { id: 'sub-1', review: 'merged' } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const client = new M.RemoteClient({ baseUrl: 'http://127.0.0.1:1', token: 't', deviceId: 'd' })
    await client.editQueue('s 1', remove)
    ok(seen[0].url.endsWith('/remote/v1/sessions/s%201/queue') && seen[0].body.op === 'remove' && /^m-/.test(seen[0].key), '排队操作发到会话的 queue 路径并带幂等键')
    await client.reviewSubagent('s-1', 'sub-1', 'merge')
    ok(seen[1].url.endsWith('/subagents/sub-1/merge') && seen[1].body.confirm === true, '合并请求带明确确认')
    await client.sendSubagent('s-1', 'sub-1', '继续')
    ok(seen[2].url.endsWith('/subagents/sub-1/send') && seen[2].body.text === '继续' && !!seen[2].key, '给子代理发消息带幂等键')
    await client.newSession('p-1', 'k-new', true)
    ok(seen[3].url.endsWith('/sessions/new') && seen[3].body.projectId === 'p-1' && seen[3].body.worktree === true && seen[3].key === 'k-new', '新建会话可带工作树')
    await client.newSession(undefined, 'k-new2')
    ok(!('worktree' in seen[4].body), '不选工作树时不带该字段，旧版电脑照常')
  } finally {
    globalThis.fetch = realFetch
  }
})
