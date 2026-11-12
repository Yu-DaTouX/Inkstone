#!/usr/bin/env node
import { runSuite } from './lib/test-suite.mjs'

const base = { kind: 'danger', tool: 'bash', title: 't', detail: 'd', reasons: [], cwd: 'c', canRemember: false }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await runSuite(import.meta.url, async (ok, compile) => {
  const { ApprovalBroker } = await compile('src/main/approval-broker.ts')
  const { APPROVAL_HOLD_MAX_MS, DANGER_CONFIRM_TIMEOUT_MS } = await compile('src/shared/approval.ts')
  ok(DANGER_CONFIRM_TIMEOUT_MS === 60_000, '审批倒计时为 1 分钟')

  const opened = []
  const snapshots = []
  const updated = []
  const broker = new ApprovalBroker({ canAsk: () => true, open: (request) => opened.push(request), close: () => undefined, update: (request) => updated.push(request), publish: (snapshot) => snapshots.push(snapshot) })

  const before = Date.now()
  const timedOut = broker.askTimed({ ...base }, 40)
  const request = opened.at(-1)
  ok(request.expiresAt >= before + 40 && request.expiresAt <= Date.now() + 40, '请求带到期时间')
  ok(await timedOut === 'timeout', '到时返回 timeout')
  ok(broker.list().length === 0, '超时后请求移除')

  const plain = broker.ask({ ...base }, undefined)
  const plainRequest = opened.at(-1)
  ok(plainRequest.expiresAt === undefined, '不带倒计时的请求没有到期时间')
  ok(broker.hold(plainRequest.id) === false, '不带倒计时的请求不能停表')
  broker.answer(plainRequest.id, 'deny')
  ok((await plain)?.choice === 'deny', 'ask 仍返回用户答复')

  const owner = { instanceId: 'pi-a', generation: 1 }
  const held = broker.askTimed({ ...base, owner }, 40)
  const heldRequest = opened.at(-1)
  const revision = heldRequest.revision
  ok(broker.hold(heldRequest.id, { owner: { instanceId: 'pi-b', generation: 1 } }) === false, '别的实例不能停表')
  const holdAt = Date.now()
  ok(broker.hold(heldRequest.id, { owner }) === true, '本实例可以停表')
  const stored = broker.list().find((item) => item.id === heldRequest.id)
  ok(stored?.held === true && stored.expiresAt >= holdAt + APPROVAL_HOLD_MAX_MS - 1000, '停表后标记并延长到期时间')
  ok(stored.revision === revision, '停表不改请求版本，答复不会因版本不符被拒')
  ok(snapshots.at(-1).items.some((item) => item.id === heldRequest.id && item.held), '停表后推送新快照')
  ok(updated.length === 1 && updated[0].id === heldRequest.id && updated[0].held === true, '停表后把更新后的请求推给界面')
  ok(broker.hold(heldRequest.id, { owner }) === false, '已停表的请求不重复停表')
  await wait(80)
  ok(broker.list().some((item) => item.id === heldRequest.id), '停表后原倒计时不再生效')
  ok(broker.answer(heldRequest.id, 'once', { owner, revision }) === true, '停表后仍能按原版本答复')
  ok((await held)?.choice === 'once', '停表后返回用户答复')

  const aborted = new AbortController()
  const cancelled = broker.askTimed({ ...base }, 1000, aborted.signal)
  aborted.abort()
  ok(await cancelled === null, '取消时返回 null，不算超时')
})
