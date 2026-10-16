/** 准备中/释放中的宿主快照也占预算；不访问真实浏览器或凭证。 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/src/features/artifacts/widget-lifecycle.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { PreviewSnapshotLifecycle } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const tasks = []
const manager = new PreviewSnapshotLifecycle(1, Date.now, (task) => tasks.push(task))
const pending = deferred()
const released = deferred()
let starts = 0
let releases = 0
manager.want('old', {
  revision: 'old',
  prepare: () => { starts++; return pending.promise },
  release: () => { releases++; return released.promise }
})
assert.equal(starts, 1, '正对照：首个请求进入真实生产 prepare')
manager.unwant('old')
for (const task of tasks.splice(0)) task()
manager.want('new', {
  revision: 'new',
  prepare: () => { starts++; return Promise.resolve({ ok: true, url: 'new-url' }) },
  release: () => {}
})
assert.equal(starts, 1, '旧 prepare 仍在途，不能因为UI entry已删除就复用宿主预算')
assert.equal(manager.occupancy(), 1, '不可见的在途 reservation 仍应占预算')
pending.resolve({ ok: true, url: 'old-url' })
await flush()
assert.equal(releases, 1, '迟到URL立即发起一次释放')
assert.equal(starts, 1, '释放IPC尚未确认，新 prepare 仍不可进入')
assert.equal(manager.occupancy(), 1, '释放中 reservation 不得提前让位')
released.resolve()
await flush()
await flush()
assert.equal(starts, 2, '宿主释放确认后，等待者自动接纳一次')
assert.equal(manager.peek('new').status, 'ready', '新块不是永久paused/busy')
assert.equal(manager.occupancy(), 1, '新块接纳后总预算仍为1')
manager.unwant('new')
for (const task of tasks.splice(0)) task()
await flush()
assert.equal(manager.occupancy(), 0, '最后清理不留资源')
/* ── 同 key 换代 A→B：旧 prepare 未回，预算不被复用 ───────────── */
{
  const tasksA = []
  const manager = new PreviewSnapshotLifecycle(1, Date.now, (task) => tasksA.push(task))
  const pendingA = deferred()
  const releasedA = []
  let startsA = 0
  let startsB = 0
  manager.want('k', {
    revision: 'A',
    prepare: () => { startsA++; return pendingA.promise },
    release: (url) => releasedA.push(url)
  })
  manager.want('k', {
    revision: 'B',
    prepare: () => { startsB++; return Promise.resolve({ ok: true, url: 'B-url' }) },
    release: () => {}
  })
  assert.equal(startsB, 0, '旧 A prepare 在途，同 key 换代不得同时开第二个 prepare')
  assert.equal(manager.occupancy(), 1, '孤立在途位仍占预算')
  assert.equal(manager.peek('k').status, 'paused', '换代块等旧位结算')
  pendingA.resolve({ ok: true, url: 'A-url' })
  await flush()
  await flush()
  assert.deepEqual(releasedA, ['A-url'], '孤立的 A URL 释放一次')
  assert.equal(startsB, 1, '旧位释放确认后 B 才真正 prepare')
  assert.equal(manager.peek('k').url, 'B-url')
  assert.equal(manager.occupancy(), 1)
  manager.unwant('k')
  for (const task of tasksA.splice(0)) task()
  await flush()
  await flush()
  assert.equal(manager.occupancy(), 0)
}

/* ── resume 抢占准备中的旧位：settle+release 确认前都不让位 ──── */
{
  const tasksB = []
  const manager = new PreviewSnapshotLifecycle(1, Date.now, (task) => tasksB.push(task))
  const pendingA = deferred()
  const releaseAck = deferred()
  const released = []
  manager.want('a', { revision: 'a', prepare: () => pendingA.promise, release: (url) => { released.push(url); return releaseAck.promise } })
  manager.want('b', { revision: 'b', prepare: () => Promise.resolve({ ok: true, url: 'b-url' }), release: () => {} })
  assert.equal(manager.peek('b').status, 'paused')
  manager.resume('b')
  assert.equal(manager.peek('a').status, 'paused', '被抢占的 pending 位可恢复')
  assert.equal(manager.peek('b').status, 'paused', 'park 准备中的位不会立刻腾出预算')
  pendingA.resolve({ ok: true, url: 'a-url' })
  await flush()
  await flush()
  assert.deepEqual(released, ['a-url'])
  assert.equal(manager.peek('b').status, 'paused', 'release 未确认前不 promote')
  assert.equal(manager.occupancy(), 1)
  releaseAck.resolve()
  await flush()
  await flush()
  assert.equal(manager.peek('b').status, 'ready', '确认后才接纳等待者')
  assert.equal(manager.peek('b').url, 'b-url')
  assert.equal(manager.occupancy(), 1)
}

/* ── 迟到失败归还 reservation 并 promote 等待者 ──────────────── */
{
  const tasksC = []
  const manager = new PreviewSnapshotLifecycle(1, Date.now, (task) => tasksC.push(task))
  const pendingA = deferred()
  manager.want('a', { revision: 'a', prepare: () => pendingA.promise, release: () => {} })
  manager.unwant('a')
  manager.want('b', { revision: 'b', prepare: () => Promise.resolve({ ok: true, url: 'b-url' }), release: () => {} })
  assert.equal(manager.peek('b').status, 'paused')
  for (const task of tasksC.splice(0)) task()
  pendingA.resolve({ ok: false, error: 'read' })
  await flush()
  await flush()
  assert.equal(manager.peek('b').status, 'ready', '迟到的失败位归还后等待者上来')
  assert.equal(manager.occupancy(), 1)
}

/* ── 多轮快速 want/unwant：并发 prepare + 未确认 release 一直接不超预算 ─ */
{
  const tasksD = []
  const manager = new PreviewSnapshotLifecycle(3, Date.now, (task) => tasksD.push(task))
  const acks = []
  let inFlight = 0
  let peakInFlight = 0
  for (let i = 0; i < 25; i++) {
    const pending = deferred()
    manager.want(`k${i}`, {
      revision: `r${i}`,
      prepare: () => {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        return pending.promise.then((result) => { inFlight--; return result })
      },
      release: () => { const ack = deferred(); acks.push(ack); return ack.promise }
    })
    assert.ok(manager.occupancy() <= 3, `want 后占用不超预算 (${manager.occupancy()})`)
    manager.unwant(`k${i}`)
    for (const task of tasksD.splice(0)) task()
    assert.ok(manager.occupancy() <= 3, `unwant 后占用不超预算 (${manager.occupancy()})`)
    pending.resolve(i % 2 === 0 ? { ok: true, url: `u${i}` } : { ok: false, error: 'read' })
    await flush()
    assert.ok(manager.occupancy() <= 3, `迟到回包后占用不超预算 (${manager.occupancy()})`)
    if (acks.length >= 3) { acks.shift().resolve(); await flush() }
  }
  assert.ok(peakInFlight <= 3, `并发 prepare 不超过预算 (peak=${peakInFlight})`)
  for (const ack of acks.splice(0)) ack.resolve()
  await flush()
  await flush()
  assert.equal(manager.occupancy(), 0, '清理后不残留未归还位')
}

/* ── 正常释放与迟到成功都恰好 cleanup 一次 ─────────────────── */
{
  const tasksE = []
  const manager = new PreviewSnapshotLifecycle(2, Date.now, (task) => tasksE.push(task))
  let releases = 0
  manager.want('c', { revision: 'c', prepare: () => Promise.resolve({ ok: true, url: 'c-url' }), release: () => { releases++ } })
  await flush()
  assert.equal(manager.peek('c').status, 'ready')
  manager.unwant('c')
  for (const task of tasksE.splice(0)) task()
  await flush()
  await flush()
  assert.equal(releases, 1, '正常释放恰好一次')

  const lateReleases = []
  const late = deferred()
  manager.want('d', { revision: 'd', prepare: () => late.promise, release: (url) => lateReleases.push(url) })
  manager.unwant('d')
  for (const task of tasksE.splice(0)) task()
  late.resolve({ ok: true, url: 'd-url' })
  await flush()
  await flush()
  assert.deepEqual(lateReleases, ['d-url'], '迟到成功释放恰好一次')
  assert.equal(manager.occupancy(), 0)
}

/* ── 同步 prepare 抛错：不锁死预算，后续块能上来 ─────────────── */
{
  const manager = new PreviewSnapshotLifecycle(1)
  manager.want('boom', { revision: 'boom', prepare: () => { throw new Error('sync boom') }, release: () => {} })
  assert.equal(manager.peek('boom').status, 'error')
  assert.equal(manager.peek('boom').error, 'read')
  assert.equal(manager.occupancy(), 0, '同步抛错立即归还 reservation')
  manager.want('next', { revision: 'next', prepare: () => Promise.resolve({ ok: true, url: 'next-url' }), release: () => {} })
  await flush()
  assert.equal(manager.peek('next').status, 'ready', '预算未被锁死')
  assert.equal(manager.occupancy(), 1)
}

/* ── release 拒绝/同步抛错：不 unhandled，保守占位不假定已释放 ── */
{
  const tasksF = []
  const errors = []
  const manager = new PreviewSnapshotLifecycle(1, Date.now, (task) => tasksF.push(task), (error, key) => errors.push([key, String(error)]))
  manager.want('rej', { revision: 'rej', prepare: () => Promise.resolve({ ok: true, url: 'rej-url' }), release: () => Promise.reject(new Error('rej-fail')) })
  await flush()
  manager.unwant('rej')
  for (const task of tasksF.splice(0)) task()
  await flush()
  await flush()
  assert.equal(errors.length, 1, '拒绝被观察且不冒泡为 unhandled')
  assert.equal(manager.occupancy(), 1, 'release 未确认且失败时不假定已释放')

  const syncErrors = []
  const manager2 = new PreviewSnapshotLifecycle(1, Date.now, (task) => queueMicrotask(task), (error, key) => syncErrors.push([key, String(error)]))
  manager2.want('sync', { revision: 'sync', prepare: () => Promise.resolve({ ok: true, url: 'sync-url' }), release: () => { throw new Error('sync-fail') } })
  await flush()
  manager2.unwant('sync')
  await flush()
  await flush()
  assert.equal(syncErrors.length, 1, '同步抛错被观察且不 unhandled')
  assert.equal(manager2.occupancy(), 1, '同步抛错同样保守占位')
}

console.log('test-v3-widget-budget-race: passed')
