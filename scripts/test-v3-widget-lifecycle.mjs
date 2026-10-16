/**
 * 小部件 / 成果预览的**有界快照生命周期 + 身份隔离**动态回归（WP-32 · T3 窄修）。
 *
 * 现场编译真实的 `widget-lifecycle.ts`（组件实际调用的那份），在 Node 里用
 * 注入的假桥与假时钟驱动异步 prepare/release：
 *   · 不启动 Electron、不碰真实 `window.yan`、不访问网络、不读用户凭证；
 *   · 不靠源码字符串匹配，直接执行组件共用的 helper。
 *
 *   node scripts/test-v3-widget-lifecycle.mjs
 */
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

/** 手动的延迟调度器：把组件里 `queueMicrotask` 的释放时机变成可控的一步。 */
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

/* ── 身份隔离 ─────────────────────────────────────────────────── */
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

  /* 两条内容相同、offset 相同的消息：只要 messageId 不同就必须不共享。 */
  const msgA = lifecycle.deriveWidgetIdentityKey({ sessionId: 's1', messageId: 'msg-a', instanceId: 'ia', localKey: '10', widgetId: 'w1' })
  const msgB = lifecycle.deriveWidgetIdentityKey({ sessionId: 's1', messageId: 'msg-b', instanceId: 'ib', localKey: '10', widgetId: 'w1' })
  assert.notEqual(msgA, msgB, '同 offset 的两条消息不共享状态')

  /* 缺真实身份：Markdown 实例或 Widget 实例任一不同即不同；绝不回退全局 'widget'。 */
  const fallback = lifecycle.deriveWidgetIdentityKey({ ...base, messageId: null })
  assert.notEqual(fallback, lifecycle.deriveWidgetIdentityKey({ ...base, messageId: null, instanceId: 'i2' }), '缺身份时按 Markdown 实例区分')
  assert.notEqual(fallback, lifecycle.deriveWidgetIdentityKey({ ...base, messageId: null, widgetId: 'w2' }), '缺身份时按 Widget 实例区分')
  assert.ok(!fallback.includes('widget'), 'fallback 不含全局 widget 常量')
  assert.ok(fallback.includes('i1') && fallback.includes('w1'), 'fallback 明确带上实例身份')

  /* HTML 成果卡身份：同一 artifact 在不同消息下不同，缺消息身份时退回 artifact id。 */
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

/* ── 17 个块有界：满员暂停，不是第 17 个永久 busy ─────────────── */
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

  /* 离屏一块：延迟释放一次，再接纳一个被预算挡下的块。 */
  const k0Url = pending.get('k0').url
  manager.unwant('k0')
  assert.equal(scheduler.size(), 1, '释放被延后合并（StrictMode 友好）')
  scheduler.run()
  await flush()
  assert.equal(manager.occupancy(), 12, '释放后立即补上一个，总量仍有界')
  assert.deepEqual(released, [k0Url], '释放恰好一次')
  assert.notEqual(manager.peek('k16').status, 'paused', '空位出现后暂停块被接纳')
}

/* ── 迟到的 prepare：离屏后才返回的 URL 必须归还 ────────────── */
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

/* ── 宿主 busy 不无限重试；用户恢复才重新申请 ─────────────────── */
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

  /* 即使别的块释放出空位，busy 也不会被 promote 自动重试。 */
  manager.want('other', { revision: 'o', prepare: () => Promise.resolve({ ok: true, url: 'u:other' }), release: (url) => released.push(url) })
  await flush()
  manager.unwant('other')
  scheduler.run()
  await flush()
  assert.equal(attempts, 1, '空位出现也不静默重试 busy')

  /* 用户点恢复 → 明确重新申请。 */
  result = { ok: true, url: 'u:busy' }
  manager.resume('busy')
  await flush()
  assert.equal(attempts, 2, '恢复后重新 prepare')
  assert.equal(manager.peek('busy').status, 'ready')
  assert.equal(manager.peek('busy').url, 'u:busy')
}

/* ── 恢复会抢占最久未见的活跃快照（有界 + 可恢复） ───────────── */
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

/* ── 同一身份、同一来源幂等：形态切换不重建、不释放 ───────────── */
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
  /* 形态（inline/panel/fullscreen/pip）不是 lifecycle 输入：再 want 不重建。 */
  manager.want('widget', { ...request })
  manager.want('widget', { ...request })
  await flush()
  assert.equal(prepares, 1, '同来源重复申请不重建 URL')
  assert.equal(releases, 0, '形态变化不释放')
  assert.equal(manager.peek('widget').url, 'u:doc')

  /* 来源真的变了才重建，并释放旧 URL。 */
  manager.want('widget', { revision: 'doc-v2', prepare: () => Promise.resolve({ ok: true, url: 'u:doc2' }), release: () => { releases++ } })
  await flush()
  assert.equal(releases, 1, '来源变化释放旧 URL')
  assert.equal(manager.peek('widget').url, 'u:doc2')
}

/* ── 两个相同来源、不同身份：不共享 URL，释放互不影响 ─────────── */
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

/* ── 两个入口（小部件 / HTML 成果）共用一个有界上限 ───────────── */
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

/* ── 错误路径：拒绝读、返回 size 等都不假装 ready ─────────────── */
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

/* ── StrictMode 双调用：unwant→want 合并，不释放重建 ─────────── */
{
  const scheduler = makeScheduler()
  const manager = new lifecycle.PreviewSnapshotLifecycle(4, () => 1, scheduler.schedule)
  let releases = 0
  const request = { revision: 'doc', prepare: () => Promise.resolve({ ok: true, url: 'u:s' }), release: () => { releases++ } }
  manager.want('s', request)
  await flush()
  assert.equal(manager.peek('s').status, 'ready')
  manager.unwant('s') // 卸载
  manager.want('s', request) // 立刻重新挂载（StrictMode）
  scheduler.run()
  await flush()
  assert.equal(manager.peek('s').status, 'ready')
  assert.equal(manager.peek('s').url, 'u:s')
  assert.equal(releases, 0, 'StrictMode 双调用不抖动')
}

console.log('test-v3-widget-lifecycle: all checks passed')
