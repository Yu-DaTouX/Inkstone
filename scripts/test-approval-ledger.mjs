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
    assert.equal(await answered, 'once')
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
    assert.equal(await legacy, 'deny')

    const closedBroker = new ApprovalBroker({ canAsk: () => false, open: () => assert.fail('不应打开'), close: () => {} })
    assert.equal(await closedBroker.ask({ ...base }), null)

    console.log('approval ledger ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
