import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const request = (over = {}) => ({ sessionId: 's1', runId: 'r1', toolCallId: 'call-1', kind: 'danger', tool: 'bash', title: 'Agent 想执行一个难以撤销的操作', detail: 'git push --force', reasons: ['强制推送'], cwd: '/w', canRemember: false, ...over })

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-approval-receipts-'))
  try {
    const broker = await compile('src/main/approval-broker.ts', join(dir, 'broker.mjs'))
    const log = await compile('src/main/approval-log.ts', join(dir, 'log.mjs'))
    const merge = await compile('src/shared/approval-log.ts', join(dir, 'merge.mjs'))

    const recorded = []
    let throwOnRecord = false
    const opened = []
    const approvals = new broker.ApprovalBroker({
      canAsk: () => true,
      open: (item) => opened.push(item),
      close: () => undefined,
      record: (item, answer) => {
        if (throwOnRecord) throw new Error('disk full')
        recorded.push({ id: item.id, toolCallId: item.toolCallId, ...answer })
      }
    })
    const ask = async (over, choice, feedback) => {
      const pending = approvals.ask(request(over))
      const asked = opened.at(-1)
      const answered = approvals.answer(asked.id, choice, undefined, feedback)
      return { answered, result: await pending, id: asked.id }
    }

    const once = await ask({ toolCallId: 'c-once' }, 'once')
    assert.equal(once.answered, true)
    assert.deepEqual(once.result, { choice: 'once' }, '允许一次：工具得到的答复不变')
    assert.deepEqual(recorded.at(-1), { id: once.id, toolCallId: 'c-once', choice: 'once' })

    const session = await ask({ toolCallId: 'c-session' }, 'session')
    assert.deepEqual(session.result, { choice: 'once' }, '会话内允许：工具仍只收到一次允许')
    assert.deepEqual(recorded.at(-1), { id: session.id, toolCallId: 'c-session', choice: 'session' }, '回执记下的是会话内允许')
    const before = recorded.length
    assert.deepEqual(await approvals.ask(request({ toolCallId: 'c-granted' })), { choice: 'once' }, '会话授权照常自动放行')
    assert.equal(recorded.length, before, '自动放行不是用户决定，不写回执')

    const deny = await ask({ runId: 'r2', toolCallId: 'c-deny' }, 'deny', '  先别推送  ')
    assert.deepEqual(deny.result, { choice: 'deny', feedback: '先别推送' }, '拒绝并反馈：反馈照常交给工具')
    assert.deepEqual(recorded.at(-1), { id: deny.id, toolCallId: 'c-deny', choice: 'deny', feedback: '先别推送' })

    const plainDeny = await ask({ runId: 'r3', toolCallId: 'c-deny2' }, 'deny', '   ')
    assert.deepEqual(plainDeny.result, { choice: 'deny' })
    assert.deepEqual(recorded.at(-1), { id: plainDeny.id, toolCallId: 'c-deny2', choice: 'deny' })

    const remember = await ask({ runId: 'r4', toolCallId: 'c-remember', kind: 'outside', canRemember: true }, 'remember')
    assert.deepEqual(remember.result, { choice: 'remember' })
    assert.equal(recorded.at(-1).choice, 'remember')

    const count = recorded.length
    const cancelled = approvals.ask(request({ runId: 'r5', toolCallId: 'c-cancel' }))
    assert.equal(approvals.cancel((item) => item.toolCallId === 'c-cancel'), 1)
    assert.equal(await cancelled, null, '取消照常得到无答复')
    const invalid = approvals.ask(request({ runId: 'r6', toolCallId: 'c-invalid' }))
    assert.equal(approvals.answer(opened.at(-1).id, 'always'), false, '非法选项照常拒收')
    approvals.cancel((item) => item.toolCallId === 'c-invalid')
    assert.equal(await invalid, null)
    const mismatched = approvals.ask(request({ runId: 'r7', toolCallId: 'c-owner', owner: { instanceId: 'a', generation: 1 } }))
    assert.equal(approvals.answer(opened.at(-1).id, 'once', { owner: { instanceId: 'b', generation: 1 } }), false, '身份不符照常拒收')
    approvals.cancel((item) => item.toolCallId === 'c-owner')
    assert.equal(await mismatched, null)
    assert.equal(recorded.length, count, '取消、非法选项和身份不符都不写回执')

    throwOnRecord = true
    const failing = await ask({ runId: 'r8', toolCallId: 'c-throw' }, 'once')
    assert.equal(failing.answered, true, '回执写失败不影响审批结果')
    assert.deepEqual(failing.result, { choice: 'once' })
    throwOnRecord = false

    const file = join(dir, 'approval-log.json')
    const store = new log.ApprovalLogStore(() => file)
    const asked = { ...request({ toolCallId: 'c-1' }), id: 'ap-1', createdAt: 1000 }
    assert.equal(store.record({ ...asked, toolCallId: undefined }, { choice: 'once' }, 2000), null, '没有工具调用 ID 的审批不写回执')
    assert.equal(store.record({ ...asked, sessionId: '../x' }, { choice: 'once' }, 2000), null, '不安全的会话 ID 被拒绝')
    const first = store.record(asked, { choice: 'deny', feedback: '  路径不对 ' }, 3000)
    assert.equal(first.sessionId, 's1')
    assert.deepEqual(first.entries, [{ id: 'ap-1', toolCallId: 'c-1', kind: 'danger', tool: 'bash', title: 'Agent 想执行一个难以撤销的操作', choice: 'deny', feedback: '路径不对', askedAt: 1000, at: 3000 }])
    const again = store.record(asked, { choice: 'deny', feedback: '路径不对' }, 3500)
    assert.equal(again.entries.length, 1, '同一审批只留一条回执')
    store.record({ ...asked, id: 'ap-2', toolCallId: 'c-2', subagentId: 'sa-1' }, { choice: 'once', feedback: '不该保存' }, 4000)
    const listed = store.list('s1')
    assert.equal(listed.length, 2)
    assert.equal(listed[1].subagentId, 'sa-1')
    assert.equal(listed[1].feedback, undefined, '只有拒绝会保存反馈')
    assert.deepEqual(store.list('other'), [])
    assert.deepEqual(store.list('../x'), [])
    for (let i = 0; i < 205; i += 1) store.record({ ...asked, id: `bulk-${i}`, toolCallId: `bulk-${i}` }, { choice: 'once' }, 5000 + i)
    assert.equal(store.list('s1').length, 200, '每个会话最多保留 200 条')
    assert.equal(store.list('s1').at(-1).id, 'bulk-204')

    writeFileSync(file, '{"version":1,"sessions":{"s1":[{"id":"x","toolCallId":"t","kind":"danger","choice":"bogus","at":1}]}}')
    assert.deepEqual(store.list('s1'), [], '无效条目被丢弃')
    writeFileSync(file, 'not json')
    assert.deepEqual(store.list('s1'), [], '损坏文件按空记录读取')
    assert.ok(readdirSync(dir).some((name) => name.startsWith('approval-log.json.corrupt-')), '损坏文件留下备份')
    assert.ok(existsSync(file))
    assert.equal(readFileSync(file, 'utf8'), 'not json', '读取时不覆盖原文件')

    const receipt = { id: 'ap-1', toolCallId: 'c-1', kind: 'danger', tool: 'bash', title: 't', choice: 'once', askedAt: 1, at: 2 }
    const messages = [
      { id: 'm1', role: 'assistant', text: '', toolCalls: [{ id: 'c-1', name: 'bash', args: {}, status: 'ok' }, { id: 'c-9', name: 'read', args: {}, status: 'ok' }] },
      { id: 'm2', role: 'assistant', text: 'done' }
    ]
    const merged = merge.mergeApprovalLog(messages, [receipt])
    assert.notEqual(merged, messages)
    assert.equal(merged[0].toolCalls[0].approval, receipt, '回执挂到对应的工具调用上')
    assert.equal(merged[0].toolCalls[1], messages[0].toolCalls[1], '其他工具调用保持原对象')
    assert.equal(merged[1], messages[1])
    assert.equal(messages[0].toolCalls[0].approval, undefined, '不改动原消息')
    assert.equal(merge.mergeApprovalLog(messages, []), messages, '没有回执时原样返回')
    assert.equal(merge.mergeApprovalLog(messages, [{ ...receipt, toolCallId: 'other' }]), messages, '对不上的回执不复制消息')
    assert.equal(merge.mergeApprovalLog(merged, [receipt]), merged, '已挂好的回执不重复复制')
    const sub = { ...receipt, id: 'ap-s', subagentId: 'sa-1' }
    assert.equal(merge.mergeApprovalLog(messages, [sub], 'sa-2'), messages, '子 Agent 回执只挂到自己的记录')
    assert.equal(merge.mergeApprovalLog(messages, [sub], 'sa-1')[0].toolCalls[0].approval, sub)
    const later = { ...receipt, id: 'ap-later', choice: 'deny', at: 9 }
    assert.equal(merge.mergeApprovalLog(messages, [later, receipt])[0].toolCalls[0].approval, later, '同一调用有多条时取最晚的决定')

    console.log('approval receipts: ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
