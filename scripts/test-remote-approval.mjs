import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runRemoteApprovalTests(ok) {
  await build({ stdin: { contents: `export * from './src/main/remote-approval'; export * from './src/main/approval-broker'; export * from './src/main/ui-requests'`, resolveDir: process.cwd() },
    outfile: 'out/test/remote-approval.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { approvalDigest, applyHumanApproval, remoteApprovalQuestion, ApprovalBroker, UiRequests } = await import(pathToFileURL('out/test/remote-approval.mjs').href)
  const question = { id: 'q1', sessionId: 's1', runId: 'r1', method: 'confirm', sensitive: true, title: 'Execute command', message: 'git reset --hard', deadline: 200 }
  const answer = { sessionId: 's1', runId: 'r1', confirmed: true, digest: approvalDigest(question) }
  const resolved = []
  ok(applyHumanApproval(question, answer, choice => resolved.push(choice), 100).ok && resolved[0] === true, '人工批准只放行已展示的具体操作')
  ok(applyHumanApproval(question, { ...answer, confirmed: false }, choice => resolved.push(choice), 100).ok && resolved[1] === false, '拒绝传回原请求')
  const count = resolved.length
  for (const changed of [{ sessionId: 'other' }, { runId: 'r2' }, { digest: '0'.repeat(64) }, { digest: 'short' }]) {
    ok(!applyHumanApproval(question, { ...answer, ...changed }, choice => resolved.push(choice), 100).ok, '不接受错会话/运行/摘要：' + Object.keys(changed)[0])
  }
  ok(!applyHumanApproval({ ...question, message: 'different operation' }, answer, choice => resolved.push(choice), 100).ok, '同一问题 ID 的内容变化必须重新展示')
  ok(!applyHumanApproval(question, answer, choice => resolved.push(choice), 200).ok, '过期批准不执行')
  ok(!applyHumanApproval(undefined, answer, choice => resolved.push(choice), 100).ok, '已处理或不存在的请求不执行')
  ok(!applyHumanApproval({ ...question, sensitive: false }, answer, choice => resolved.push(choice), 100).ok, '普通问题不借用敏感批准通道')
  ok(resolved.length === count, '所有失败路径均未调用放行回调')
  ok(!applyHumanApproval(question, answer, () => false, 100).ok, '请求在答复时已消失则不报告批准成功')
  const closed = []
  const broker = new ApprovalBroker({ canAsk: () => true, open: () => {}, close: id => closed.push(id) })
  const waiting = broker.ask({ kind: 'danger', tool: 'bash', title: 'Approval', detail: 'danger fixture', reasons: ['risk'], cwd: 'fixture', canRemember: false, sessionId: 's1', runId: 'r1', subagentId: 'child1' })
  const request = broker.list()[0]
  const remote = remoteApprovalQuestion(request)
  ok(remote.sessionId === 's1' && remote.runId === 'r1' && remote.message.includes('child1') && remote.message.includes('danger fixture'), '实际批准卡保留父会话/运行/子 Agent 与完整操作')
  ok(applyHumanApproval(remote, { sessionId: 's1', runId: 'r1', digest: remote.approvalDigest, confirmed: true }, choice => broker.answer(request.id, choice ? 'once' : 'deny')).ok, '远程人工决定答复同一个 ApprovalBroker')
  ok(await waiting === 'once' && broker.list().length === 0 && closed[0] === request.id, '原任务解除等待，桌面卡片同步移除')
  ok(!broker.answer(request.id, 'once'), '处理过的批准不能再次放行')
  const piResponses = []
  const ui = new UiRequests({ push: () => {}, respondToPi: response => piResponses.push(response) })
  ui.handleUi({ id: 'sensitive', method: 'confirm', sensitive: true })
  ok(!ui.answerUiRemotely('sensitive', { confirmed: true }).ok && piResponses.length === 0, '普通远程 answer 仍不能批准敏感操作')
  ok(ui.answerUiRemotely('sensitive', { cancelled: true }).ok, '原有取消路径保留')
}

if (process.argv[1]?.endsWith('test-remote-approval.mjs')) {
  let passed = 0, failed = 0
  await runRemoteApprovalTests((value, name) => { if (value) passed++; else { failed++; console.error('FAIL', name) } })
  console.log(`${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
