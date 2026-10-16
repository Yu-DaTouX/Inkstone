/**
 * v3 终端会话控制器单测（P3 / R2）。
 *
 * 用 esbuild 把纯逻辑 `features/terminal/terminal-session.ts` 编译到内存，
 * 再注入一个**隔离 mock bridge** 驱动：不启动 Electron、不碰 node-pty、
 * 不发送任何真实 shell 命令、不写用户数据目录。覆盖：
 *   · 归属筛选：只认 `resource-owners` 里记到本 owner 的终端，不抢未登记的工具 PTY；
 *   · active=false 不 create/attach/data/write/resize；
 *   · 快速切会话：迟到的 attach 回包与旧 id 的 data/exit 不串新终端；
 *   · attach 期间实时块排队 + 按 seq 去重；
 *   · 启动失败给出可重试错误（不永久禁用），重试可恢复；
 *   · visible=false 不发 resize；卸载只 detach 不 kill；只有显式「结束」才 kill。
 *
 *   node scripts/test-v3-terminal.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/terminal/terminal-session.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const { TerminalSession, selectOwnedTerminals, pickOwnedTerminal } = mod

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

/** 反复让出微任务直到条件成立（异步链长度不定），避免测试依赖固定轮数。 */
const until = async (cond, rounds = 400) => {
  for (let i = 0; i < rounds; i += 1) {
    if (cond()) return
    await Promise.resolve()
  }
  throw new Error('until: 条件未在预期轮数内成立')
}

function snapshot(over = {}) {
  return {
    id: 't1',
    title: 'bash',
    shell: '/bin/bash',
    cwd: '/work/proj',
    cols: 80,
    rows: 24,
    alive: true,
    exitCode: null,
    buffer: '',
    seq: 0,
    ...over
  }
}

/** 隔离 mock：记录调用、可注入行为、手动触发推送。 */
function harness(overrides = {}) {
  const calls = { available: 0, list: 0, start: [], write: [], resize: [], kill: [], attach: [], claim: [], release: [] }
  const owners = new Map()
  let pushHandler = null
  const raw = {
    available: async () => ({ available: true }),
    list: async () => [],
    start: async (request) => snapshot({ id: 't-new', cwd: request?.cwd ?? '', cols: request?.cols ?? 80, rows: request?.rows ?? 24 }),
    write: async () => true,
    resize: async () => true,
    kill: async () => true,
    attach: async (id) => snapshot({ id }),
    ...(overrides.bridge ?? {})
  }
  const bridge = {
    available: async () => {
      calls.available += 1
      return raw.available()
    },
    list: async () => {
      calls.list += 1
      return raw.list()
    },
    start: async (request) => {
      calls.start.push(request)
      return raw.start(request)
    },
    write: async (id, data) => {
      calls.write.push([id, data])
      return raw.write(id, data)
    },
    resize: async (id, cols, rows) => {
      calls.resize.push([id, cols, rows])
      return raw.resize(id, cols, rows)
    },
    kill: async (id) => {
      calls.kill.push(id)
      return raw.kill(id)
    },
    attach: async (id) => {
      calls.attach.push(id)
      return raw.attach(id)
    }
  }
  const controller = new TerminalSession({
    bridge,
    onPush: (cb) => {
      pushHandler = cb
      return () => {
        pushHandler = null
      }
    },
    ownerOf: (resource) => owners.get(resource),
    claim: (resource, key) => {
      calls.claim.push([resource, key])
      if (!owners.has(resource)) owners.set(resource, key)
    },
    release: (resource) => {
      calls.release.push(resource)
      owners.delete(resource)
    },
    text: overrides.text
  })
  const writes = []
  controller.setSink({
    reset: () => writes.push('<reset>'),
    write: (data) => writes.push(data)
  })
  return {
    controller,
    calls,
    writes,
    owners,
    push: (payload) => pushHandler?.({ ch: 'terminal', payload }),
    subscribed: () => pushHandler !== null
  }
}

function owner(over = {}) {
  return { key: 'key-A', sessionId: 's1', cwd: '/work/proj', active: true, ...over }
}

/* ── 1. 纯归属筛选 ───────────────────────────────────────────────── */
{
  const list = [snapshot({ id: 'tool', alive: true }), snapshot({ id: 'mine', alive: true })]
  const owners = new Map([['terminal:mine', 'key-A']])
  const owned = selectOwnedTerminals(list, 'key-A', (r) => owners.get(r))
  assert.equal(owned.length, 1, '只选归属于本 owner 的终端')
  assert.equal(owned[0].id, 'mine', '未登记的终端（工具 PTY）不被认领')
  assert.equal(pickOwnedTerminal([]), null)
  assert.equal(pickOwnedTerminal([snapshot({ id: 'a', alive: false })]).id, 'a', '没有存活时仍返回最后一个')
  assert.equal(pickOwnedTerminal([snapshot({ id: 'a', alive: false }), snapshot({ id: 'b', alive: true })]).id, 'b', '优先存活')
}

/* ── 2. 未激活：不 create / attach / write / resize ──────────────── */
{
  const h = harness()
  h.controller.setOwner(owner({ active: false }))
  await flush()
  assert.equal(h.calls.available, 0, 'active=false 不查询能力')
  assert.equal(h.calls.list, 0, 'active=false 不列终端')
  assert.equal(h.calls.start.length, 0, 'active=false 不新建 PTY')
  assert.equal(h.calls.attach.length, 0, 'active=false 不 attach')
  h.controller.input('echo hi')
  h.controller.resize(120, 30)
  await h.controller.create()
  await flush()
  assert.equal(h.calls.write.length, 0, 'active=false 不写输入')
  assert.equal(h.calls.resize.length, 0, 'active=false 不 resize')
  assert.equal(h.calls.start.length, 0, 'active=false 的 create() 被拒绝')
  assert.equal(h.controller.getState().phase, 'inactive', '未激活显示 inactive')
  await flush()
  /* 回到激活：只有这时才建立终端。 */
  const h2 = harness({ bridge: { list: async () => [snapshot({ id: 'owned' })], attach: async (id) => snapshot({ id }) } })
  h2.owners.set('terminal:owned', 'key-A')
  h2.controller.setOwner(owner({ active: false }))
  await flush()
  assert.equal(h2.calls.attach.length, 0)
  h2.controller.setOwner(owner({ active: true }))
  await flush()
  assert.equal(h2.calls.attach.length, 1, '激活后才 attach')
  console.log('  终端：未激活不触碰 PTY ✓')
}

/* ── 3. 附加已有归属终端 + 推送 + 重连去重 ───────────────────────── */
{
  const deferred = { resolve: null }
  const h = harness({
    bridge: {
      list: async () => [snapshot({ id: 'tool-pty', alive: true }), snapshot({ id: 'owned', alive: true })],
      attach: (id) => new Promise((resolve) => {
        deferred.resolve = () => resolve(snapshot({ id, buffer: 'B0', seq: 3 }))
      })
    }
  })
  h.owners.set('terminal:owned', 'key-A')
  h.controller.setOwner(owner())
  await until(() => h.calls.attach.length === 1)
  /* attach 在途时到达的实时块：先入队。 */
  h.push({ id: 'owned', kind: 'data', data: 'live4', seq: 4 })
  h.push({ id: 'owned', kind: 'data', data: 'dup2', seq: 2 })
  h.push({ id: 'owned', kind: 'data', data: 'other', seq: 9 })
  deferred.resolve()
  await flush()
  assert.equal(h.controller.getState().phase, 'ready')
  assert.deepEqual(
    h.writes.filter((w) => w !== '<reset>'),
    ['B0', 'live4', 'other'],
    '快照缓冲先写，排队的实时块按 seq 去重（dup2 丢弃）'
  )
  assert.equal(h.calls.attach.length, 1, '只 attach 归属终端')
  assert.equal(h.calls.attach[0], 'owned', '未登记的 tool-pty 不被 adopt')
  assert.ok(h.calls.resize.some((r) => r[0] === 'owned'), 'attach 后同步一次尺寸')

  /* exit 只改当前终端状态。 */
  h.push({ id: 'owned', kind: 'exit', exitCode: 0 })
  await flush()
  assert.equal(h.controller.getState().phase, 'exited')
  assert.equal(h.controller.getState().exitCode, 0)
  console.log('  终端：附加归属终端与回放去重 ✓')
}

/* ── 4. 新建：cwd 只来自 owner，登记归属 ─────────────────────────── */
{
  const h = harness()
  h.controller.setOwner(owner({ cwd: '/work/proj' }))
  await flush()
  assert.equal(h.calls.start.length, 1, '没有归属终端时新建一个')
  const request = h.calls.start[0]
  assert.equal(request.cwd, '/work/proj', 'cwd 来自 owner')
  assert.equal(request.fallbackCwd, '/work/proj', 'fallbackCwd 同样来自 owner，不落到别会话')
  assert.deepEqual(h.calls.claim.at(-1), ['terminal:t-new', 'key-A'], '新建后登记正式归属')
  assert.equal(h.owners.get('terminal:t-new'), 'key-A')
  console.log('  终端：新建仅用 owner.cwd 并登记归属 ✓')
}

/* ── 5. 启动失败：可重试，不永久禁用 ─────────────────────────────── */
{
  let fail = true
  const h = harness({
    bridge: {
      list: async () => [],
      available: async () => ({ available: true }),
      start: async (request) => (fail ? null : snapshot({ id: 'retry-ok', cwd: request?.cwd ?? '' }))
    }
  })
  h.controller.setOwner(owner())
  await flush()
  assert.equal(h.controller.getState().phase, 'error', '启动失败进入可重试的 error')
  assert.ok(h.controller.getState().notice.length > 0, '带提示文案')
  assert.notEqual(h.controller.getState().phase, 'unavailable', '壳 / cwd 失败不等于原生能力不可用')
  fail = false
  await h.controller.retry()
  await flush()
  assert.equal(h.controller.getState().phase, 'ready', '重试后恢复 ready')
  assert.equal(h.controller.getState().terminalId, 'retry-ok')
  console.log('  终端：启动失败可重试且不永久禁用 ✓')
}

/* ── 5b. 原生能力不可用同样是可重试，不永久禁用 ─────────────────── */
{
  let ok = false
  const h = harness({
    bridge: {
      available: async () => (ok ? { available: true } : { available: false, error: 'node-pty 没有加载' }),
      list: async () => [snapshot({ id: 'owned' })],
      attach: async (id) => snapshot({ id })
    }
  })
  h.owners.set('terminal:owned', 'key-A')
  h.controller.setOwner(owner())
  await flush()
  assert.equal(h.controller.getState().phase, 'unavailable')
  assert.equal(h.controller.getState().error, 'node-pty 没有加载')
  ok = true
  await h.controller.retry()
  await flush()
  assert.equal(h.controller.getState().phase, 'ready', '原生依赖恢复后重试可用')
  console.log('  终端：能力不可用可重试且不永久禁用 ✓')
}

/* ── 6. 快速切会话：迟到回包与旧 id 推送不串新终端 ───────────────── */
{
  const pending = new Map()
  const h = harness({
    bridge: {
      list: async () => [snapshot({ id: 'A' }), snapshot({ id: 'B' })],
      attach: (id) => new Promise((resolve) => pending.set(id, resolve))
    }
  })
  h.owners.set('terminal:A', 'key-A')
  h.owners.set('terminal:B', 'key-B')
  h.controller.setOwner(owner({ key: 'key-A', sessionId: 'a' }))
  await until(() => pending.has('A'))
  h.controller.setOwner(owner({ key: 'key-B', sessionId: 'b' }))
  await until(() => pending.has('B'))
  assert.ok(pending.has('A') && pending.has('B'), '两次 attach 都在途（旧请求不会取消，但会被 epoch 判定过期）')

  /* A 的迟到回包：不得写进 B 的 xterm。 */
  pending.get('A')(snapshot({ id: 'A', buffer: 'STALE-A', seq: 5 }))
  await flush()
  assert.ok(!h.writes.includes('STALE-A'), '迟到的旧 attach 回包被丢弃')

  /* 旧 id 的 data / exit：不得影响新终端。 */
  h.push({ id: 'A', kind: 'data', data: 'ghost', seq: 6 })
  h.push({ id: 'A', kind: 'exit', exitCode: 7 })
  await flush()
  assert.ok(!h.writes.includes('ghost'), '旧终端数据不串新终端')
  assert.notEqual(h.controller.getState().phase, 'exited', '旧终端 exit 不把新终端标成退出')

  /* B 正常回包与后续数据。 */
  pending.get('B')(snapshot({ id: 'B', buffer: 'B0', seq: 1 }))
  await flush()
  assert.equal(h.controller.getState().phase, 'ready')
  assert.equal(h.controller.getState().terminalId, 'B')
  h.push({ id: 'B', kind: 'data', data: 'new-B', seq: 2 })
  await flush()
  assert.ok(h.writes.includes('B0') && h.writes.includes('new-B'), '新终端正常接收')
  console.log('  终端：切换会话后迟到 data/exit/attach 不串流 ✓')
}

/* ── 7. resize 的可见性与销毁语义 ───────────────────────────────── */
{
  const h = harness({
    bridge: { list: async () => [snapshot({ id: 'owned' })], attach: async (id) => snapshot({ id }) }
  })
  h.owners.set('terminal:owned', 'key-A')
  h.controller.setOwner(owner())
  await flush()
  h.controller.resize(120, 30)
  await flush()
  assert.deepEqual(h.calls.resize.at(-1), ['owned', 120, 30], '可见时 resize 到 PTY')

  h.controller.setVisible(false)
  const count = h.calls.resize.length
  h.controller.resize(130, 40)
  await flush()
  assert.equal(h.calls.resize.length, count, '隐藏时不发 resize')

  h.controller.setVisible(true)
  await flush()
  assert.deepEqual(h.calls.resize.at(-1), ['owned', 130, 40], '重新可见补一次当前尺寸')

  h.controller.dispose()
  assert.equal(h.calls.kill.length, 0, '卸载不 kill')
  assert.equal(h.subscribed(), false, '卸载退订推送')
  console.log('  终端：resize 可见性门控与卸载不 kill ✓')
}

/* ── 8. 只有显式「结束」才 kill，并释放归属 ──────────────────────── */
{
  const h = harness({
    bridge: { list: async () => [snapshot({ id: 'owned' })], attach: async (id) => snapshot({ id }) }
  })
  h.owners.set('terminal:owned', 'key-A')
  h.controller.setOwner(owner())
  await flush()
  await h.controller.kill()
  await flush()
  assert.deepEqual(h.calls.kill, ['owned'], '显式结束才 kill')
  assert.deepEqual(h.calls.release, ['terminal:owned'], '结束时释放归属')
  assert.equal(h.owners.has('terminal:owned'), false)
  assert.equal(h.controller.getState().phase, 'idle')
  /* 结束后同 owner 重渲染不应自动重开。 */
  h.controller.setOwner(owner())
  await flush()
  assert.equal(h.calls.start.length, 0, '用户结束后不自动新建')
  console.log('  终端：显式结束 kill + 释放归属，且不自动重开 ✓')
}

console.log('v3 终端会话：归属 / 激活门控 / 迟到消息隔离 / resize / 销毁检查通过')
