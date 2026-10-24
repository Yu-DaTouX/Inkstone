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

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-operation-gate-'))
  try {
    const { SessionOperationGate, generationMatches, GENERATION_MISMATCH_ERROR, sessionOperationBusyError } =
      await compile('src/main/session-operation-gate.ts', join(dir, 'gate.mjs'))

    assert.equal(generationMatches(undefined, 3), true)
    assert.equal(generationMatches(3, 3), true)
    assert.equal(generationMatches(2, 3), false)
    assert.equal(generationMatches(2, undefined), false)
    assert.match(GENERATION_MISMATCH_ERROR, /旧实例/)
    assert.match(sessionOperationBusyError('fork', 'compact'), /压缩.*分叉/)

    const gate = new SessionOperationGate()
    const send1 = gate.acquire('send', 1)
    const send2 = gate.acquire('send', 1)
    assert.ok(send1.ok && send2.ok, '多个发送可以排队')
    const compact = gate.acquire('compact', 1)
    assert.ok(compact.ok, '发送期间仍可压缩，由 pi 排队')
    const fork = gate.acquire('fork', 1)
    assert.equal(fork.ok, false)
    assert.ok(['send', 'compact'].includes(fork.holder))
    assert.equal(gate.acquire('compact', 1).ok, false, '不能重复压缩')
    assert.equal(gate.release(send1.lease), true)
    assert.equal(gate.release(send1.lease), false)
    gate.release(send2.lease)
    assert.deepEqual(gate.busy(), ['compact'])
    assert.equal(gate.acquire('rewind', 1).ok, false)
    assert.equal(gate.acquire('send', 1).ok, true, '压缩不挡发送')

    gate.reset()
    const pending = gate.acquire('compact', 1)
    assert.equal(gate.markUnknown(pending.lease), true)
    assert.equal(gate.release(pending.lease), false, '结果未知时保留锁')
    assert.equal(gate.acquire('fork', 1).ok, false)
    assert.equal(gate.settle('send'), 0)
    assert.equal(gate.settle('compact'), 1, '终态事件释放未知锁')
    assert.equal(gate.acquire('fork', 1).ok, true)
    assert.equal(gate.acquire('send', 1).ok, false, '分叉期间不能发送')
    assert.equal(gate.acquire('rewind', 1).ok, false)
    gate.reset()
    assert.deepEqual(gate.busy(), [])
    const reload = gate.acquire('reload', 1)
    assert.equal(reload.ok, true)
    for (const op of ['send', 'compact', 'fork', 'rewind', 'reload']) assert.equal(gate.acquire(op, 1).ok, false, `重新加载阻止 ${op}`)
    gate.release(reload.lease)
    assert.equal(gate.acquire('send', 1).ok, true, '重新加载结束恢复发送')
    assert.equal(gate.acquire('reload', 1).ok, false, '发送中不能重新加载')
    gate.reset()

    const order = []
    const result = await gate.run('fork', 2, async (lease) => {
      order.push(lease.op, lease.generation)
      assert.equal((await gate.run('send', 2, async () => 'inner', (error) => error)).includes('分叉'), true)
      return 'done'
    }, (error) => error)
    assert.equal(result, 'done')
    assert.deepEqual(order, ['fork', 2])
    assert.deepEqual(gate.busy(), [])
    await assert.rejects(gate.run('rewind', 1, async () => { throw new Error('boom') }, (error) => error), /boom/)
    assert.deepEqual(gate.busy(), [], '失败也释放锁')

    console.log('session operation gate ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
