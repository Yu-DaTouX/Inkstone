import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function loadTs(relativePath) {
  const source = fileURLToPath(new URL(relativePath, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const lifecycle = await loadTs('../src/renderer/src/features/artifacts/widget-lifecycle.ts')

async function runWidgetLifecycle() {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  function makeScheduler() {
    const tasks = []
    return {
      schedule: (task) => tasks.push(task),
      run() {
        const current = tasks.splice(0)
        for (const task of current) task()
        return current.length
      },
      size: () => tasks.length
    }
  }

  {
    const base = { sessionId: 's1', messageId: 'm1', instanceId: 'i1', localKey: '10', widgetId: 'w1' }
    const key = lifecycle.deriveWidgetIdentityKey(base)
    assert.equal(lifecycle.deriveWidgetIdentityKey({ ...base }), key, '同一身份稳定')
    assert.notEqual(lifecycle.deriveWidgetIdentityKey({ ...base, messageId: 'm2' }), key, '跨消息身份不同')
    assert.notEqual(lifecycle.deriveWidgetIdentityKey({ ...base, sessionId: 's2' }), key, '跨会话身份不同')
    assert.notEqual(lifecycle.deriveWidgetIdentityKey({ ...base, localKey: '11' }), key, '同消息不同位置不同')
    assert.notEqual(lifecycle.deriveWidgetIdentityKey({ ...base, instanceId: 'another-fragment' }), key, '同源消息的不同 Markdown 实例不能共用 offset 键')
    assert.notEqual(
      lifecycle.deriveWidgetIdentityKey({ ...base, sessionId: null, instanceId: 'path-only-a' }),
      lifecycle.deriveWidgetIdentityKey({ ...base, sessionId: null, instanceId: 'path-only-b' }),
      '未知会话身份、相同短消息 ID 也不可跨显示实例共享状态'
    )

    const msgA = lifecycle.deriveWidgetIdentityKey({ sessionId: 's1', messageId: 'msg-a', instanceId: 'ia', localKey: '10', widgetId: 'w1' })
    const msgB = lifecycle.deriveWidgetIdentityKey({ sessionId: 's1', messageId: 'msg-b', instanceId: 'ib', localKey: '10', widgetId: 'w1' })
    assert.notEqual(msgA, msgB, '同 offset 的两条消息不共享状态')

    const fallback = lifecycle.deriveWidgetIdentityKey({ ...base, messageId: null })
    assert.notEqual(fallback, lifecycle.deriveWidgetIdentityKey({ ...base, messageId: null, instanceId: 'i2' }), '缺身份时按 Markdown 实例区分')
    assert.notEqual(fallback, lifecycle.deriveWidgetIdentityKey({ ...base, messageId: null, widgetId: 'w2' }), '缺身份时按 Widget 实例区分')
    assert.ok(!fallback.includes('widget'), 'fallback 不含全局 widget 常量')
    assert.ok(fallback.includes('i1') && fallback.includes('w1'), 'fallback 明确带上实例身份')

    assert.notEqual(
      lifecycle.deriveArtifactIdentityKey('s1', 'm1', 'art1'),
      lifecycle.deriveArtifactIdentityKey('s1', 'm2', 'art1'),
      '同 artifact 跨消息不共享'
    )
    assert.equal(
      lifecycle.deriveArtifactIdentityKey(null, null, 'art1'),
      lifecycle.deriveArtifactIdentityKey(null, null, 'art1'),
      '缺消息身份时用 artifact id 稳定'
    )
    assert.ok(lifecycle.MAX_PREVIEW_SNAPSHOTS < 16, '客户端快照上限低于主进程 16，不改 host limit')
  }

  {
    const scheduler = makeScheduler()
    let clock = 0
    const manager = new lifecycle.PreviewSnapshotLifecycle(12, () => ++clock, scheduler.schedule)
    const pending = new Map()
    const released = []
    let prepared = 0
    const request = (key) => ({
      revision: `rev:${key}`,
      prepare: () => {
        prepared++
        const url = `inkstone-html://${String(prepared).padStart(32, '0')}/index.html`
        const ticket = deferred()
        pending.set(key, { ticket, url })
        return ticket.promise
      },
      release: (url) => released.push(url)
    })

    for (let i = 0; i < 17; i++) manager.want(`k${i}`, request(`k${i}`))
    assert.equal(prepared, 12, '同一时刻只申请 12 个快照')
    assert.equal(manager.occupancy(), 12, '占用等于上限，不越界')
    assert.equal(manager.peek('k16').status, 'paused', '第 17 个是明确暂停')
    assert.notEqual(manager.peek('k16').error, 'busy', '暂停不是宿主 busy')

    for (let i = 0; i < 12; i++) {
      const entry = pending.get(`k${i}`)
      entry.ticket.resolve({ ok: true, url: entry.url })
    }
    await flush()
    assert.equal(manager.occupancy(), 12)
    assert.equal(manager.peek('k0').status, 'ready')

    const k0Url = pending.get('k0').url
    manager.unwant('k0')
    assert.equal(scheduler.size(), 1, '释放被延后合并（StrictMode 友好）')
    scheduler.run()
    await flush()
    assert.equal(manager.occupancy(), 12, '释放后立即补上一个，总量仍有界')
    assert.deepEqual(released, [k0Url], '释放恰好一次')
    assert.notEqual(manager.peek('k16').status, 'paused', '空位出现后暂停块被接纳')
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(4, () => 1, scheduler.schedule)
    const released = []
    const late = deferred()
    manager.want('late', { revision: 'late', prepare: () => late.promise, release: (url) => released.push(url) })
    assert.equal(manager.peek('late').status, 'preparing')
    manager.unwant('late')
    scheduler.run()
    assert.equal(manager.peek('late').status, 'idle')
    late.resolve({ ok: true, url: 'inkstone-html://late' })
    await flush()
    assert.deepEqual(released, ['inkstone-html://late'], '迟到 URL 及时 release')
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(2, () => 1, scheduler.schedule)
    let attempts = 0
    let result = { ok: false, error: 'busy' }
    const released = []
    const busyRequest = {
      revision: 'r',
      prepare: () => {
        attempts++
        return Promise.resolve(result)
      },
      release: (url) => released.push(url)
    }
    manager.want('busy', busyRequest)
    await flush()
    assert.equal(manager.peek('busy').status, 'paused')
    assert.equal(manager.peek('busy').error, 'busy')
    assert.equal(attempts, 1, 'busy 后不自动重试')

    manager.want('other', { revision: 'o', prepare: () => Promise.resolve({ ok: true, url: 'u:other' }), release: (url) => released.push(url) })
    await flush()
    manager.unwant('other')
    scheduler.run()
    await flush()
    assert.equal(attempts, 1, '空位出现也不静默重试 busy')

    result = { ok: true, url: 'u:busy' }
    manager.resume('busy')
    await flush()
    assert.equal(attempts, 2, '恢复后重新 prepare')
    assert.equal(manager.peek('busy').status, 'ready')
    assert.equal(manager.peek('busy').url, 'u:busy')
  }

  {
    const scheduler = makeScheduler()
    let clock = 0
    const manager = new lifecycle.PreviewSnapshotLifecycle(2, () => ++clock, scheduler.schedule)
    const released = []
    const ready = (url) => ({ revision: url, prepare: () => Promise.resolve({ ok: true, url }), release: (u) => released.push(u) })
    manager.want('a', ready('u:a'))
    await flush()
    manager.want('b', ready('u:b'))
    await flush()
    assert.equal(manager.occupancy(), 2)
    manager.want('c', ready('u:c'))
    assert.equal(manager.peek('c').status, 'paused')

    manager.resume('c')
    await flush()
    assert.deepEqual(released, ['u:a'], '抢占最久未见的 a')
    assert.equal(manager.peek('a').status, 'paused', 'a 变成可恢复的暂停')
    assert.equal(manager.peek('c').status, 'ready')
    assert.equal(manager.occupancy(), 2)
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(4, () => 1, scheduler.schedule)
    let prepares = 0
    let releases = 0
    const request = {
      revision: 'doc-v1',
      prepare: () => {
        prepares++
        return Promise.resolve({ ok: true, url: 'u:doc' })
      },
      release: () => {
        releases++
      }
    }
    manager.want('widget', request)
    await flush()
    assert.equal(prepares, 1)
    manager.want('widget', { ...request })
    manager.want('widget', { ...request })
    await flush()
    assert.equal(prepares, 1, '同来源重复申请不重建 URL')
    assert.equal(releases, 0, '形态变化不释放')
    assert.equal(manager.peek('widget').url, 'u:doc')

    manager.want('widget', { revision: 'doc-v2', prepare: () => Promise.resolve({ ok: true, url: 'u:doc2' }), release: () => { releases++ } })
    await flush()
    assert.equal(releases, 1, '来源变化释放旧 URL')
    assert.equal(manager.peek('widget').url, 'u:doc2')
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(4, () => 1, scheduler.schedule)
    const released = []
    const request = (key) => ({
      revision: 'same-content',
      prepare: () => Promise.resolve({ ok: true, url: `u:${key}` }),
      release: (url) => released.push(url)
    })
    manager.want('k1', request('k1'))
    manager.want('k2', request('k2'))
    await flush()
    assert.equal(manager.peek('k1').url, 'u:k1')
    assert.equal(manager.peek('k2').url, 'u:k2', '相同来源不同身份各自就绪')
    manager.unwant('k1')
    scheduler.run()
    await flush()
    assert.equal(manager.peek('k2').url, 'u:k2', '释放 k1 不影响 k2')
    assert.deepEqual(released, ['u:k1'])
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(2, () => 1, scheduler.schedule)
    const released = []
    manager.want('widget:msg\0x\0w', { revision: 'doc', prepare: () => Promise.resolve({ ok: true, url: 'u:widget' }), release: (u) => released.push(u) })
    manager.want('artifact:p1', { revision: 'C:/a.html', prepare: () => Promise.resolve({ ok: true, url: 'u:artifact' }), release: (u) => released.push(u) })
    manager.want('widget:msg\0x\0z', { revision: 'doc2', prepare: () => Promise.resolve({ ok: true, url: 'u:widget2' }), release: (u) => released.push(u) })
    await flush()
    assert.equal(manager.occupancy(), 2, '两个入口合计不超上限')
    assert.equal(manager.peek('widget:msg\0x\0z').status, 'paused')
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(4, () => 1, scheduler.schedule)
    manager.want('reject', { revision: 'r', prepare: () => Promise.reject(new Error('boom')), release: () => {} })
    manager.want('size', { revision: 'r', prepare: () => Promise.resolve({ ok: false, error: 'size' }), release: () => {} })
    await flush()
    assert.equal(manager.peek('reject').status, 'error')
    assert.equal(manager.peek('reject').error, 'read')
    assert.equal(manager.peek('size').status, 'error')
    assert.equal(manager.peek('size').error, 'size')
    assert.equal(manager.occupancy(), 0)
  }

  {
    const scheduler = makeScheduler()
    const manager = new lifecycle.PreviewSnapshotLifecycle(4, () => 1, scheduler.schedule)
    let releases = 0
    const request = { revision: 'doc', prepare: () => Promise.resolve({ ok: true, url: 'u:s' }), release: () => { releases++ } }
    manager.want('s', request)
    await flush()
    assert.equal(manager.peek('s').status, 'ready')
    manager.unwant('s')
    manager.want('s', request)
    scheduler.run()
    await flush()
    assert.equal(manager.peek('s').status, 'ready')
    assert.equal(manager.peek('s').url, 'u:s')
    assert.equal(releases, 0, 'StrictMode 双调用不抖动')
  }

  console.log('test-v3-widget-lifecycle: all checks passed')
}

async function runWidgetBudgetRace() {
  const { PreviewSnapshotLifecycle } = lifecycle
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
}

await runWidgetLifecycle()
await runWidgetBudgetRace()
