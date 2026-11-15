import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

export async function runRemoteApprovalTests(ok) {
  await build({ stdin: { contents: `export * from './src/main/remote-approval'; export * from './src/main/approval-broker'; export * from './src/main/ui-requests'`, resolveDir: process.cwd() },
    outfile: 'out/test/remote-approval.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { approvalDigest, applyHumanApproval, remoteApprovalQuestion, ApprovalBroker, UiRequests, questionToolCallId } = await import(pathToFileURL('out/test/remote-approval.mjs').href)
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
  ok((await waiting)?.choice === 'once' && broker.list().length === 0 && closed[0] === request.id, '原任务解除等待，桌面卡片同步移除')
  ok(!broker.answer(request.id, 'once'), '处理过的批准不能再次放行')
  const piResponses = []
  const ui = new UiRequests({ push: () => {}, respondToPi: response => { piResponses.push(response); return true } })
  ui.handleUi({ id: 'sensitive', method: 'confirm', sensitive: true })
  ok(!(await ui.answerUiRemotely('sensitive', { confirmed: true })).ok && piResponses.length === 0, '普通远程 answer 仍不能批准敏感操作')
  ok((await ui.answerUiRemotely('sensitive', { cancelled: true })).ok, '原有取消路径保留')
  ui.handleUi({ id: 'secret-input', method: 'input', sensitive: true, title: 'Password' })
  const secretRemote = await ui.answerUiRemotely('secret-input', { value: 'hunter2' })
  ok(!secretRemote.ok && secretRemote.code === 'sensitive_confirmation_requires_desktop' && piResponses.length === 1, '密码类提问不能经远程普通 answer 填写')
  ok(ui.pendingUiRequests().some(item => item.id === 'secret-input'), '远程填写密码被拒后问题仍待桌面回答')
  const secretConfirm = await ui.answerUiRemotely('secret-input', { confirmed: true })
  ok(!secretConfirm.ok && piResponses.length === 1, '密码类提问也不能经远程 confirmed 结束')
  ok(!applyHumanApproval({ ...question, method: 'input' }, { ...answer, digest: approvalDigest({ ...question, method: 'input' }) }, choice => resolved.push(choice), 100).ok && resolved.length === count, '密码类提问不能借用人工批准通道')
  const secretPushed = []
  const secretHost = new UiRequests({ push: msg => secretPushed.push(msg), respondToPi: () => true })
  let secretSettled = false
  const secretAsk = secretHost.requestHostUi({ method: 'input', message: 'token', form: [{ name: 'token', label: 'Token', kind: 'secret' }], sensitive: true, timeout: 1000 })
  secretAsk.then(() => { secretSettled = true }, () => { secretSettled = true })
  const secretId = secretPushed[0].payload.id
  const hostSecretRemote = await secretHost.answerUiRemotely(secretId, { value: JSON.stringify({ token: 'hunter2' }) })
  await new Promise(resolve => setTimeout(resolve, 0))
  ok(!hostSecretRemote.ok && hostSecretRemote.code === 'sensitive_confirmation_requires_desktop' && !secretSettled, '砚自己的密码表单不能经远程 answer 填写')
  ok((await secretHost.answerUiRemotely(secretId, { cancelled: true })).ok && (await secretAsk).cancelled === true, '密码表单仍可远程取消')
  const pushed = []
  const asked = new UiRequests({ push: msg => pushed.push(msg), respondToPi: () => {} })
  const answering = asked.requestHostUi({ method: 'select', title: 'Q', message: 'pick', options: ['a'], timeout: 1000, toolCallId: 'call_q1' })
  ok(pushed[0]?.payload.toolCallId === 'call_q1', '提问请求携带 toolCallId 推送到渲染端')
  await asked.respondUi({ id: pushed[0].payload.id, value: 'a' })
  ok((await answering).value === 'a', '带 toolCallId 的提问仍可正常回答')
  const plain = asked.requestHostUi({ method: 'input', title: 'Q', message: 'm', timeout: 1000 })
  const plainPayload = pushed.filter(msg => msg.ch === 'ui-request')[1].payload
  ok(!('toolCallId' in plainPayload), '没有 toolCallId 的提问不带该字段')
  await asked.respondUi({ id: plainPayload.id, value: 'x' })
  await plain
  const fields = [{ name: 'side', label: '哪一方', kind: 'choice', options: [{ label: '甲' }, { label: '乙' }] }, { name: 'note', label: '备注', kind: 'text' }]
  const formAsk = asked.requestHostUi({ method: 'input', message: '合同选哪一方', form: fields, timeout: 1000 })
  const formRequest = asked.pendingUiRequests().find(item => item.form)
  ok(formRequest?.form?.length === 2 && formRequest.message === '合同选哪一方', '表单问题在待答列表里保留字段与问题正文')
  ok((await asked.answerUiRemotely(formRequest.id, { value: JSON.stringify({ side: '甲', note: '快' }) })).ok, '手机端可以提交表单答案')
  ok((await formAsk).value === '{"side":"甲","note":"快"}', '表单答案原样交回提问方')
  ok(questionToolCallId({ toolCall: { id: 'call_n' } }) === 'call_n' && questionToolCallId({ toolCallId: 'call_f' }) === undefined && questionToolCallId({}) === undefined, 'toolCallId 只从工具通道的 toolCall.id 取得')
}

await runSuite(import.meta.url, async (ok) => {
  await runRemoteApprovalTests(ok)
}, { isolate: true })
