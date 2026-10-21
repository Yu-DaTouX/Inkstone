import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const base = { kind: 'danger', tool: 'bash', title: 't', detail: 'd', reasons: [], cwd: 'c', canRemember: false }

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-approval-ledger-'))
  try {
    const { ApprovalLedger, sameOwner, approvalIdentityFrom } = await compile('src/main/approval-ledger.ts', join(dir, 'ledger.mjs'))
    const { ApprovalBroker } = await compile('src/main/approval-broker.ts', join(dir, 'broker.mjs'))

    const a = { instanceId: 'pi-a', generation: 1 }
    const b = { instanceId: 'pi-b', generation: 1 }
    const a2 = { instanceId: 'pi-a', generation: 2 }
    assert.equal(sameOwner(a, { ...a }), true)
    assert.equal(sameOwner(a, a2), false)
    assert.equal(sameOwner(undefined, undefined), true)
    assert.equal(approvalIdentityFrom(null), undefined)
    assert.equal(approvalIdentityFrom({ owner: { instanceId: 1 } }), undefined)
    assert.deepEqual(approvalIdentityFrom({ owner: { instanceId: 'pi-a', generation: 1 }, revision: 3 }), { owner: a, revision: 3 })

    const ledger = new ApprovalLedger()
    ledger.activate('run:r1', a)
    const first = ledger.add({ ...base, id: 'x1', createdAt: 1, owner: a }, 'run:r1')
    assert.equal(first.phase, 'pending')
    assert.equal(first.revision, 1)
    assert.equal(ledger.add({ ...base, id: 'x1', createdAt: 1, owner: a }, 'run:r1'), null)
    assert.equal(ledger.add({ ...base, id: 'old', createdAt: 1, owner: b }, 'run:r1'), null)
    const second = ledger.add({ ...base, id: 'x2', createdAt: 2, owner: a }, 'run:r1')
    assert.ok(second.revision > first.revision)
    assert.equal(ledger.snapshot().items.length, 2)
    assert.equal(ledger.snapshot().revision, ledger.currentRevision)

    assert.deepEqual(ledger.begin('nope'), { ok: false, reason: 'missing' })
    assert.deepEqual(ledger.begin('x1', { owner: b }), { ok: false, reason: 'owner-mismatch' })
    assert.deepEqual(ledger.begin('x1', { revision: 999 }), { ok: false, reason: 'revision-mismatch' })
    const begun = ledger.begin('x1', { owner: a, revision: first.revision })
    assert.equal(begun.ok, true)
    assert.equal(begun.request.phase, 'sending')
    assert.deepEqual(ledger.begin('x1'), { ok: false, reason: 'sending' })
    assert.deepEqual(ledger.pending().map((item) => item.id), ['x2'])
    assert.deepEqual(ledger.expire(() => true), ['x2'])
    assert.equal(ledger.finish('x2').id, 'x2')
    assert.equal(ledger.finish('x1').phase, 'resolved')
    assert.equal(ledger.finish('x1'), null)

    ledger.add({ ...base, id: 'y1', createdAt: 3, owner: a }, 'run:r1')
    ledger.add({ ...base, id: 'y2', createdAt: 3 }, 'run:r1')
    ledger.add({ ...base, id: 'z1', createdAt: 3, owner: b }, 'run:r2')
    assert.deepEqual(ledger.activate('run:r1', a), [])
    assert.deepEqual(ledger.activate('run:r1', a2), ['y1'])
    ledger.finish('y1')
    assert.equal(ledger.isCurrent('run:r1', a), false)
    assert.equal(ledger.isCurrent('run:r1', a2), true)
    assert.equal(ledger.isCurrent('run:r9', a), true)
    assert.deepEqual(ledger.retire('run:r2', a), [])
    assert.deepEqual(ledger.retire('run:r2'), ['z1'])

    const opened = []
    const closed = []
    const snapshots = []
    const broker = new ApprovalBroker({
      canAsk: () => true,
      open: (request) => opened.push(request),
      close: (id) => closed.push(id),
      publish: (snapshot) => snapshots.push(snapshot)
    })
    broker.activate('r1', a)
    const answered = broker.ask({ ...base, runId: 'r1', owner: a, toolCallId: 'call_7' })
    const request = opened[0]
    assert.equal(request.toolCallId, 'call_7')
    assert.equal(request.phase, 'pending')
    assert.equal(snapshots.at(-1).items.length, 1)
    assert.equal(broker.answer(request.id, 'bogus'), false)
    assert.equal(broker.answer(request.id, 'once', { owner: b }), false)
    assert.equal(broker.answer(request.id, 'once', { owner: a, revision: request.revision }), true)
    assert.equal(broker.answer(request.id, 'once'), false)
    assert.equal((await answered)?.choice, 'once')
    assert.deepEqual(closed, [request.id])
    assert.equal(snapshots.at(-1).items.length, 0)
    assert.ok(snapshots.some((snapshot) => snapshot.items[0]?.phase === 'sending'))
    const revisions = snapshots.map((snapshot) => snapshot.revision)
    assert.deepEqual(revisions, [...revisions].sort((x, y) => x - y))

    const restarted = broker.ask({ ...base, runId: 'r1', owner: a })
    const stale = opened[1]
    assert.equal(broker.activate('r1', b), 1)
    assert.equal(await restarted, null)
    assert.equal(broker.answer(stale.id, 'once'), false)
    assert.equal(await broker.ask({ ...base, runId: 'r1', owner: a }), null)
    assert.equal(opened.length, 2)

    const turn = broker.ask({ ...base, runId: 'r1', owner: b })
    const child = broker.ask({ ...base, runId: 'r1', subagentId: 's1' })
    assert.equal(broker.cancel((pending) => pending.runId === 'r1' && !pending.subagentId), 1)
    assert.equal(await turn, null)
    assert.equal(broker.list().length, 1)
    assert.equal(broker.retire('r1'), 0)
    assert.equal(broker.cancel((pending) => pending.subagentId === 's1'), 1)
    assert.equal(await child, null)

    const legacy = broker.ask({ ...base, runId: 'r3' })
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await legacy)?.choice, 'deny')

    const openedBefore = opened.length
    broker.activate('r4', a)
    const granting = broker.ask({ ...base, runId: 'r4', owner: a })
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    assert.equal((await granting)?.choice, 'once')
    assert.equal((await broker.ask({ ...base, runId: 'r4', owner: a }))?.choice, 'once')
    assert.equal(opened.length, openedBefore + 1)
    const otherTool = broker.ask({ ...base, runId: 'r4', owner: a, tool: 'write' })
    assert.equal(opened.length, openedBefore + 2)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await otherTool)?.choice, 'deny')
    const otherKind = broker.ask({ ...base, runId: 'r4', owner: a, kind: 'delete' })
    assert.equal(opened.length, openedBefore + 3)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await otherKind)?.choice, 'deny')
    const dangerA = { ...base, runId: 'r4', owner: a, kind: 'danger', reasons: ['danger-A'] }
    const dangerGrant = broker.ask(dangerA)
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    await dangerGrant
    const dangerOpened = opened.length
    assert.equal((await broker.ask(dangerA))?.choice, 'once')
    assert.equal(opened.length, dangerOpened)
    const dangerB = broker.ask({ ...dangerA, reasons: ['danger-B'] })
    assert.equal(opened.length, dangerOpened + 1, 'session grant for one danger reason must not cover another')
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await dangerB)?.choice, 'deny')
    const consentA = { ...base, runId: 'r4', owner: a, kind: 'consent', tool: 'mail', title: 'mail send' }
    const consentGrant = broker.ask(consentA)
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    await consentGrant
    const consentOther = broker.ask({ ...consentA, title: 'mail delete' })
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await consentOther)?.choice, 'deny')
    const runOpened = opened.length
    const otherRun = broker.ask({ ...base, runId: 'r5' })
    assert.equal(opened.length, runOpened + 1)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await otherRun)?.choice, 'deny')

    const withFeedback = broker.ask({ ...base, runId: 'r6' })
    assert.equal(broker.answer(opened.at(-1).id, 'deny', undefined, '  请改用项目内的路径  '), true)
    const feedbackAnswer = await withFeedback
    assert.equal(feedbackAnswer?.choice, 'deny')
    assert.equal(feedbackAnswer?.feedback, '请改用项目内的路径')
    const longFeedback = broker.ask({ ...base, runId: 'r7' })
    assert.equal(broker.answer(opened.at(-1).id, 'deny', undefined, 'x'.repeat(900)), true)
    assert.equal((await longFeedback)?.feedback?.length, 500)
    const blankFeedback = broker.ask({ ...base, runId: 'r8' })
    assert.equal(broker.answer(opened.at(-1).id, 'deny', undefined, '   '), true)
    assert.equal((await blankFeedback)?.feedback, undefined)
    const allowWithFeedback = broker.ask({ ...base, runId: 'r9' })
    assert.equal(broker.answer(opened.at(-1).id, 'once', undefined, '这个不该被带上'), true)
    const allowAnswer = await allowWithFeedback
    assert.equal(allowAnswer?.choice, 'once')
    assert.equal(allowAnswer?.feedback, undefined)

    const outsideA = { ...base, runId: 'r4', owner: a, kind: 'outside', rememberDirs: ['/x'], canRemember: true }
    const outsideAsk = broker.ask(outsideA)
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    assert.equal((await outsideAsk)?.choice, 'once')
    assert.equal((await broker.ask(outsideA))?.choice, 'once')
    const outsideOther = broker.ask({ ...outsideA, rememberDirs: ['/y'] })
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await outsideOther)?.choice, 'deny')

    const moveAsk = broker.ask({ ...base, runId: 'r4', owner: a, kind: 'move', tool: 'session' })
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    assert.equal((await moveAsk)?.choice, 'once')
    const moveAgain = broker.ask({ ...base, runId: 'r4', owner: a, kind: 'move', tool: 'session' })
    assert.equal(broker.list().length, 1)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await moveAgain)?.choice, 'deny')

    broker.activate('r4', b)
    const afterSwitch = broker.ask({ ...base, runId: 'r4', owner: b })
    assert.equal(broker.list().length, 1)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await afterSwitch)?.choice, 'deny')

    const regrant = broker.ask({ ...base, runId: 'r4', owner: b })
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    await regrant
    assert.equal((await broker.ask({ ...base, runId: 'r4', owner: b }))?.choice, 'once')
    broker.retire('r4', a)
    assert.equal((await broker.ask({ ...base, runId: 'r4', owner: b }))?.choice, 'once')
    broker.retire('r4')
    const afterRetire = broker.ask({ ...base, runId: 'r4', owner: b })
    assert.equal(broker.list().length, 1)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    assert.equal((await afterRetire)?.choice, 'deny')

    const childGrant = broker.ask({ ...base, subagentId: 'c1' })
    assert.equal(broker.answer(opened.at(-1).id, 'session'), true)
    await childGrant
    assert.equal((await broker.ask({ ...base, subagentId: 'c1' }))?.choice, 'once')
    broker.forgetSubagent('c1')
    const childAfter = broker.ask({ ...base, subagentId: 'c1' })
    assert.equal(broker.list().length, 1)
    assert.equal(broker.answer(opened.at(-1).id, 'deny'), true)
    await childAfter

    const closedBroker =new ApprovalBroker({ canAsk: () => false, open: () => assert.fail('不应打开'), close: () => {} })
    assert.equal(await closedBroker.ask({ ...base }), null)

    console.log('approval ledger ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
