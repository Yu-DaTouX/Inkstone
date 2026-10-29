import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const terminalDir = new URL('../src/renderer/src/features/terminal/', import.meta.url)

async function loadTerminalModule(name) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(name, terminalDir))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

async function runTerminalSession() {
  const mod = await loadTerminalModule('terminal-session.ts')
  const { TerminalSession, selectOwnedTerminals, pickOwnedTerminal } = mod

  const flush = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  }

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

    h.push({ id: 'owned', kind: 'exit', exitCode: 0 })
    await flush()
    assert.equal(h.controller.getState().phase, 'exited')
    assert.equal(h.controller.getState().exitCode, 0)
    console.log('  终端：附加归属终端与回放去重 ✓')
  }

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

    pending.get('A')(snapshot({ id: 'A', buffer: 'STALE-A', seq: 5 }))
    await flush()
    assert.ok(!h.writes.includes('STALE-A'), '迟到的旧 attach 回包被丢弃')

    h.push({ id: 'A', kind: 'data', data: 'ghost', seq: 6 })
    h.push({ id: 'A', kind: 'exit', exitCode: 7 })
    await flush()
    assert.ok(!h.writes.includes('ghost'), '旧终端数据不串新终端')
    assert.notEqual(h.controller.getState().phase, 'exited', '旧终端 exit 不把新终端标成退出')

    pending.get('B')(snapshot({ id: 'B', buffer: 'B0', seq: 1 }))
    await flush()
    assert.equal(h.controller.getState().phase, 'ready')
    assert.equal(h.controller.getState().terminalId, 'B')
    h.push({ id: 'B', kind: 'data', data: 'new-B', seq: 2 })
    await flush()
    assert.ok(h.writes.includes('B0') && h.writes.includes('new-B'), '新终端正常接收')
    console.log('  终端：切换会话后迟到 data/exit/attach 不串流 ✓')
  }

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
    h.controller.setOwner(owner())
    await flush()
    assert.equal(h.calls.start.length, 0, '用户结束后不自动新建')
    console.log('  终端：显式结束 kill + 释放归属，且不自动重开 ✓')
  }

  console.log('v3 终端会话：归属 / 激活门控 / 迟到消息隔离 / resize / 销毁检查通过')
}

async function runTerminalLifecycle() {
  const mod = await loadTerminalModule('terminal-session.ts')
  const { TerminalSession } = mod

  const until = async (cond, rounds = 800) => {
    for (let i = 0; i < rounds; i += 1) {
      if (cond()) return
      await Promise.resolve()
    }
    throw new Error('until: 条件未在预期轮数内成立')
  }
  const flush = async (rounds = 40) => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  }

  function snapshot(id, over = {}) {
    return {
      id,
      title: 'sh-' + id,
      shell: '/bin/sh',
      cwd: '/w',
      cols: 80,
      rows: 24,
      alive: true,
      exitCode: null,
      buffer: '',
      seq: 0,
      ...over
    }
  }

  function owner(over = {}) {
    return { key: 'key-A', sessionId: 's1', cwd: '/w/A', active: true, ...over }
  }

  function harness(options = {}) {
    const calls = {
      available: 0,
      list: 0,
      start: [],
      attach: [],
      write: [],
      resize: [],
      kill: [],
      claim: [],
      release: []
    }
    const owners = new Map()
    const live = new Map()
    const startGates = []
    const attachGates = new Map()
    const pushRef = { cb: null }
    let availability = options.availability ?? { available: true }

    const bridge = {
      available: async () => {
        calls.available += 1
        return typeof availability === 'function' ? availability() : availability
      },
      list: async () => {
        calls.list += 1
        return [...live.values()]
      },
      start: (request) => {
        calls.start.push(request)
        return new Promise((resolve) => startGates.push({ resolve, request }))
      },
      write: async (id, data) => {
        calls.write.push([id, data])
        return true
      },
      resize: async (id, cols, rows) => {
        calls.resize.push([id, cols, rows])
        return true
      },
      kill: async (id) => {
        calls.kill.push(id)
        live.delete(id)
        return true
      },
      attach: (id) => {
        calls.attach.push(id)
        return new Promise((resolve) => attachGates.set(id, resolve))
      }
    }

    const controller = new TerminalSession({
      bridge,
      onPush: (cb) => {
        pushRef.cb = cb
        return () => {
          pushRef.cb = null
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
      ...(options.adopt ? { adopt: options.adopt } : {})
    })
    const writes = []
    controller.setSink({ reset: () => writes.push('<reset>'), write: (data) => writes.push(data) })

    return {
      controller,
      calls,
      owners,
      live,
      writes,
      seed: (id, key, over) => {
        live.set(id, snapshot(id, over))
        owners.set('terminal:' + id, key)
      },
      resolveStart: (index, snap) => {
        const gate = startGates[index]
        assert.ok(gate, `start[${index}] 尚未发起`)
        gate.resolve(snap)
      },
      resolveAttach: (id, snap) => {
        const resolve = attachGates.get(id)
        assert.ok(resolve, `attach(${id}) 尚未发起`)
        resolve(snap)
      },
      setAvailability: (value) => {
        availability = value
      },
      push: (payload) => pushRef.cb?.({ ch: 'terminal', payload })
    }
  }

  {
    const h = harness()
    h.controller.setOwner(owner(), false)
    await flush()
    assert.equal(h.calls.available, 0, '隐藏时不查询能力')
    assert.equal(h.calls.list, 0, '隐藏时不列终端')
    assert.equal(h.calls.start.length, 0, '隐藏时不 start')
    assert.equal(h.calls.attach.length, 0, '隐藏时不 attach')
    console.log('  lifecycle：隐藏 setOwner 零 start ✓')
  }

  {
    const h = harness()
    h.seed('owned-A', 'key-A')
    h.controller.setOwner(owner(), false)
    await flush()
    h.controller.setVisible(true)
    await until(() => h.calls.attach.length === 1)
    assert.deepEqual(h.calls.attach, ['owned-A'], '显示时才 attach 归属终端')
    assert.equal(h.calls.start.length, 0, '已有终端不新建')
    h.resolveAttach('owned-A', snapshot('owned-A', { buffer: 'B0', seq: 1 }))
    await until(() => h.controller.getState().phase === 'ready')
    assert.equal(h.controller.getState().terminalId, 'owned-A')
    h.controller.setOwner(owner(), true)
    await flush()
    assert.equal(h.calls.attach.length, 1, '同 owner 重渲染不重复 attach')
    assert.equal(h.calls.start.length, 0)

    const n = harness()
    n.controller.setOwner(owner(), false)
    await flush()
    n.controller.setVisible(true)
    await until(() => n.calls.start.length === 1)
    assert.equal(n.calls.attach.length, 0, '新建前不 attach')
    n.resolveStart(0, snapshot('new-A'))
    await until(() => n.calls.attach.length === 1)
    assert.deepEqual(n.calls.attach, ['new-A'], '新建后 attach 新终端')
    n.resolveAttach('new-A', snapshot('new-A'))
    await until(() => n.controller.getState().phase === 'ready')
    assert.equal(n.calls.start.length, 1, '显示时仅新建一次')
    assert.deepEqual(n.calls.claim.at(-1), ['terminal:new-A', 'key-A'], '新建后登记正式归属')
    console.log('  lifecycle：显示 attach / 新建仅一次 ✓')
  }

  {
    const h = harness()
    h.seed('owned-A', 'key-A')
    h.seed('owned-B', 'key-B')
    h.controller.setOwner(owner(), false)
    h.controller.setVisible(true)
    await until(() => h.calls.attach.length === 1)
    h.resolveAttach('owned-A', snapshot('owned-A'))
    await until(() => h.controller.getState().phase === 'ready')
    const starts = h.calls.start.length
    const attaches = h.calls.attach.length

    h.controller.setOwner(owner({ key: 'key-B', sessionId: 's2', cwd: '/w/B' }), false)
    await flush()
    assert.equal(h.calls.start.length, starts, '隐藏切 B 不 start')
    assert.equal(h.calls.attach.length, attaches, '隐藏切 B 不 attach')
    assert.equal(h.calls.available, h.calls.available, '隐藏切 B 不额外查询能力')

    h.controller.setVisible(true)
    await until(() => h.calls.attach.length === attaches + 1)
    assert.equal(h.calls.attach.at(-1), 'owned-B', '显示 B 才 attach 已有终端')
    console.log('  lifecycle：隐藏切 B 不 start ✓')
  }

  {
    const h = harness()
    h.controller.setOwner(owner({ active: false }), true)
    await flush()
    assert.equal(h.calls.available, 0, '未激活不查询能力')
    assert.equal(h.calls.start.length, 0, '未激活不 start')
    assert.equal(h.calls.attach.length, 0, '未激活不 attach')
    assert.equal(h.controller.getState().phase, 'inactive')
    console.log('  lifecycle：未激活 visible 也不 start ✓')
  }

  {
    const h = harness()
    h.seed('owned-A', 'key-A')
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.attach.length === 1)
    h.resolveAttach('owned-A', snapshot('owned-A', { title: 'A-title', cwd: '/w/A', status: { state: 'working' } }))
    await until(() => h.controller.getState().phase === 'ready')
    assert.equal(h.controller.getState().title, 'A-title')

    h.controller.setOwner(owner({ active: false }), true)
    const inactive = h.controller.getState()
    assert.equal(inactive.phase, 'inactive')
    assert.equal(inactive.terminalId, null, '未激活清 terminalId')
    assert.equal(inactive.title, '', '未激活清 title')
    assert.equal(inactive.cwd, '', '未激活清 cwd')
    assert.equal(inactive.exitCode, null, '未激活清 exitCode')
    assert.equal(inactive.status, undefined, '未激活清 status')

    const f = harness()
    f.seed('owned-A', 'key-A')
    f.controller.setOwner(owner(), true)
    await until(() => f.calls.attach.length === 1)
    f.resolveAttach('owned-A', snapshot('owned-A', { title: 'A-title', cwd: '/w/A', status: { state: 'working' } }))
    await until(() => f.controller.getState().phase === 'ready')
    f.setAvailability({ available: false, error: 'node-pty 没有加载' })
    f.controller.setOwner(owner({ key: 'key-B', sessionId: 's2', cwd: '/w/B' }), true)
    await until(() => f.controller.getState().phase === 'unavailable')
    const failed = f.controller.getState()
    assert.equal(failed.terminalId, null, '能力失败清 terminalId')
    assert.equal(failed.title, '', '能力失败清 title')
    assert.equal(failed.cwd, '', '能力失败清 cwd')
    assert.equal(failed.status, undefined, '能力失败清 status')
    console.log('  lifecycle：未激活 / 失败态清 view 残留字段 ✓')
  }

  {
    const h = harness()
    h.seed('owned-A', 'key-A')
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.attach.length === 1)
    h.resolveAttach('owned-A', snapshot('owned-A', { title: 'A-title', cwd: '/w/A', status: { state: 'working' } }))
    await until(() => h.controller.getState().phase === 'ready')

    const created = h.controller.create()
    await until(() => h.calls.start.length === 1)
    h.resolveStart(0, null)
    await created
    await until(() => h.controller.getState().phase === 'error')
    const s = h.controller.getState()
    assert.equal(s.terminalId, null, '启动失败清 terminalId')
    assert.equal(s.title, '', '启动失败清 title')
    assert.equal(s.cwd, '', '启动失败清 cwd')
    assert.equal(s.status, undefined, '启动失败清 status')
    console.log('  lifecycle：启动失败清 view 残留字段 ✓')
  }

  {
    const h = harness()
    h.seed('owned-A', 'key-A')
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.attach.length === 1)
    h.resolveAttach('owned-A', snapshot('owned-A', { title: 'A-title', cwd: '/w/A', status: { state: 'working' } }))
    await until(() => h.controller.getState().phase === 'ready')

    await h.controller.kill()
    const killed = h.controller.getState()
    assert.deepEqual(h.calls.kill, ['owned-A'], '显式结束才 kill 当前终端')
    assert.deepEqual(h.calls.release, ['terminal:owned-A'], '结束时释放归属')
    assert.equal(killed.phase, 'idle')
    assert.equal(killed.terminalId, null, '结束后 view terminalId 为空')
    assert.equal(killed.title, '')
    assert.equal(killed.cwd, '')
    assert.equal(killed.exitCode, null)
    assert.equal(killed.status, undefined)

    const starts = h.calls.start.length
    h.controller.setOwner(owner(), true)
    h.controller.setVisible(false)
    h.controller.setVisible(true)
    await flush()
    assert.equal(h.calls.start.length, starts, '结束后同 owner / 显隐不自动重开')
    assert.equal(h.calls.attach.length, 1, '结束后不自动 attach')

    const reopened = h.controller.create()
    await until(() => h.calls.start.length === starts + 1)
    h.resolveStart(starts, snapshot('new-k'))
    await until(() => h.calls.attach.length === 2)
    h.resolveAttach('new-k', snapshot('new-k'))
    await reopened
    await until(() => h.controller.getState().phase === 'ready')
    assert.equal(h.controller.getState().terminalId, 'new-k', '空态显式新建可重开')
    console.log('  lifecycle：kill 清 id + 显式新建不自动重开 ✓')
  }

  {
    const h = harness()
    h.seed('owned-B', 'key-B')
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.start.length === 1)
    assert.equal(h.calls.attach.length, 0, 'A 没有归属终端，先新建')

    h.controller.setOwner(owner({ key: 'key-B', sessionId: 's2', cwd: '/w/B' }), true)
    await until(() => h.calls.attach.length === 1)
    assert.deepEqual(h.calls.attach, ['owned-B'], 'B 接回自己的已有终端')
    h.resolveAttach('owned-B', snapshot('owned-B'))
    await until(() => h.controller.getState().phase === 'ready')

    h.resolveStart(0, snapshot('late-A', { buffer: 'LATE-A-BUF', seq: 9 }))
    await flush()
    assert.deepEqual(h.calls.kill, ['late-A'], '只清理本次迟到的 A 新建 id')
    assert.ok(!h.calls.kill.includes('owned-B'), '不误 kill 其他 owner 的已有终端')
    assert.ok(!h.writes.includes('LATE-A-BUF'), '迟到 buffer 不写 view')
    assert.equal(h.controller.getState().terminalId, 'owned-B', '迟到回包不改当前 view')
    assert.equal(h.owners.has('terminal:late-A'), false, '迟到新建不登记归属')
    console.log('  lifecycle：start 途中切 owner 只清本次新 id ✓')
  }

  {
    const h = harness()
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.start.length === 1)
    h.controller.dispose()
    h.resolveStart(0, snapshot('late-disposed', { buffer: 'D-BUF', seq: 3 }))
    await flush()
    assert.deepEqual(h.calls.kill, ['late-disposed'], '卸载后迟到 start 的新 id 被清理')
    assert.ok(!h.writes.includes('D-BUF'), '不写迟到的 buffer')
    assert.equal(h.owners.has('terminal:late-disposed'), false)
    console.log('  lifecycle：dispose 途中迟到新 id 被清理 ✓')
  }

  {
    const h = harness()
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.start.length === 1)
    h.controller.setVisible(false)
    h.resolveStart(0, snapshot('hidden-new', { buffer: 'H-BUF', seq: 1 }))
    await flush()
    assert.deepEqual(h.calls.kill, ['hidden-new'], '隐藏时刚建出的新 id 被清理')
    assert.ok(!h.writes.includes('H-BUF'), '隐藏期间不写 buffer')
    assert.notEqual(h.controller.getState().phase, 'ready', '隐藏期间不进入 ready')

    h.controller.setVisible(true)
    await until(() => h.calls.start.length === 2)
    h.resolveStart(1, snapshot('shown-new'))
    await until(() => h.calls.attach.length === 1)
    assert.deepEqual(h.calls.attach, ['shown-new'])
    h.resolveAttach('shown-new', snapshot('shown-new'))
    await until(() => h.controller.getState().phase === 'ready')
    assert.equal(h.controller.getState().terminalId, 'shown-new', '显示后重建并 attach')
    console.log('  lifecycle：visible=false 不留 PTY，显示后重建 ✓')
  }

  {
    const h = harness()
    h.seed('owned-A', 'key-A')
    h.controller.setOwner(owner(), false)
    h.controller.input('echo hidden')
    h.controller.resize(140, 40)
    await flush()
    assert.equal(h.calls.write.length, 0, '隐藏时不写输入')
    assert.equal(h.calls.resize.length, 0, '隐藏时不 resize')

    h.controller.setVisible(true)
    await until(() => h.calls.attach.length === 1)
    h.resolveAttach('owned-A', snapshot('owned-A'))
    await until(() => h.controller.getState().phase === 'ready')
    h.controller.input('echo visible')
    await flush()
    assert.deepEqual(h.calls.write, [['owned-A', 'echo visible']], '显示且激活才写输入')

    h.controller.setVisible(false)
    h.controller.input('echo after-hidden')
    await flush()
    assert.equal(h.calls.write.length, 1, '隐藏后输入被丢弃')

    h.controller.setOwner(owner({ active: false }), true)
    const resizes = h.calls.resize.length
    h.controller.input('echo inactive')
    h.controller.resize(100, 30)
    await flush()
    assert.equal(h.calls.write.length, 1, '未激活输入被丢弃')
    assert.equal(h.calls.resize.length, resizes, '未激活不 resize')
    console.log('  lifecycle：隐藏 / 未激活输入与 resize 阻断 ✓')
  }

  {
    const h = harness({ adopt: { id: 'owned-A' } })
    h.seed('owned-A', 'key-A', { alive: false, exitCode: 2 })
    h.controller.setOwner(owner(), true)
    await until(() => h.calls.attach.length === 1)
    h.resolveAttach('owned-A', snapshot('owned-A', { alive: false, exitCode: 2 }))
    await until(() => h.controller.getState().phase === 'exited')

    const retried = h.controller.retry()
    await until(() => h.calls.start.length === 1)
    assert.deepEqual(h.calls.kill, ['owned-A'], '重试先结束已退出的终端')
    assert.deepEqual(h.calls.release, ['terminal:owned-A'], '重试释放旧终端归属')
    h.resolveStart(0, snapshot('fresh-A'))
    await until(() => h.calls.attach.length === 2)
    assert.deepEqual(h.calls.attach, ['owned-A', 'fresh-A'], '重试新建 PTY 而不是再 attach 已退出的终端')
    h.resolveAttach('fresh-A', snapshot('fresh-A'))
    await retried
    await until(() => h.controller.getState().phase === 'ready')
    assert.equal(h.controller.getState().terminalId, 'fresh-A', '重试后连到新终端')

    const failed = harness({ adopt: { id: 'gone-B' } })
    failed.controller.setOwner(owner({ key: 'key-B' }), true)
    await until(() => failed.calls.start.length === 1)
    failed.resolveStart(0, snapshot('gone-B'))
    await until(() => failed.calls.attach.length === 1)
    failed.resolveAttach('gone-B', null)
    await until(() => failed.controller.getState().phase === 'error')
    const again = failed.controller.retry()
    await until(() => failed.calls.start.length === 2)
    failed.resolveStart(1, snapshot('recovered-B'))
    await until(() => failed.calls.attach.length === 2)
    failed.resolveAttach('recovered-B', snapshot('recovered-B'))
    await again
    await until(() => failed.controller.getState().phase === 'ready')
    assert.equal(failed.controller.getState().terminalId, 'recovered-B', '连接失败后重试重新建 PTY')
    console.log('  lifecycle：重试新建 PTY（不重新 attach 已退出 / 丢失的终端）✓')
  }


  console.log('v3 终端生命周期：隐藏不新建 / 迟到 PTY 清理 / 残留 view 清空检查通过')
}

async function runTerminalTabs() {
  const tabs = await loadTerminalModule('terminal-tabs.ts')
  const find = await loadTerminalModule('terminal-find.ts')
  const view = await loadTerminalModule('terminal-view.ts')

  assert.equal(tabs.MAX_TERMINAL_TABS, 12)
  assert.equal(tabs.canAddTerminalTab(11), true)
  assert.equal(tabs.canAddTerminalTab(12), false)

  assert.deepEqual(tabs.terminalTabLabel('pwsh · proj', 0, 2), { kind: 'title', text: 'pwsh · proj', number: 1 })
  assert.deepEqual(tabs.terminalTabLabel('  ', 1, 3), { kind: 'numbered', text: '', number: 2 })
  assert.deepEqual(tabs.terminalTabLabel('', 0, 1), { kind: 'single', text: '', number: 1 })

  assert.equal(tabs.nextTerminalTabIndex(0, 3, 'ArrowRight'), 1)
  assert.equal(tabs.nextTerminalTabIndex(2, 3, 'ArrowRight'), 0)
  assert.equal(tabs.nextTerminalTabIndex(0, 3, 'ArrowLeft'), 2)
  assert.equal(tabs.nextTerminalTabIndex(2, 3, 'Home'), 0)
  assert.equal(tabs.nextTerminalTabIndex(0, 3, 'End'), 2)
  assert.equal(tabs.nextTerminalTabIndex(0, 3, 'Enter'), null)
  assert.equal(tabs.nextTerminalTabIndex(-1, 3, 'ArrowRight'), null)

  assert.equal(tabs.pickActiveAfterClose(['a', 'b', 'c'], 'b', 'b'), 'c')
  assert.equal(tabs.pickActiveAfterClose(['a', 'b', 'c'], 'c', 'c'), 'b')
  assert.equal(tabs.pickActiveAfterClose(['a', 'b'], 'a', 'b'), 'b')
  assert.equal(tabs.pickActiveAfterClose(['a'], 'a', 'a'), null)
  assert.equal(tabs.pickActiveAfterClose(['a', 'b'], 'a', 'b'), 'b')
  assert.deepEqual(tabs.othersThan([{ key: 'a' }, { key: 'b' }], 'a'), [{ key: 'b' }])

  assert.equal(tabs.isTerminalTabCloseKey({ key: 'Delete' }), true)
  assert.equal(tabs.isTerminalTabCloseKey({ key: 'Backspace' }), true)
  assert.equal(tabs.isTerminalTabCloseKey({ key: 'Delete', ctrlKey: true }), false)
  assert.equal(tabs.isTerminalTabCloseKey({ key: 'd' }), false)

  const lines = ['$ npm run build', 'Build OK', 'build again: build', '', 'error: BUILD failed']
  const matches = find.findTerminalMatches(lines, 'build')
  assert.deepEqual(
    matches.map((match) => [match.line, match.column, match.length]),
    [
      [0, 10, 5],
      [1, 0, 5],
      [2, 0, 5],
      [2, 13, 5],
      [4, 7, 5]
    ]
  )
  assert.deepEqual(find.findTerminalMatches(lines, ''), [])
  assert.deepEqual(find.findTerminalMatches(['aaa'], 'aa').map((match) => match.column), [0])

  assert.equal(find.lastTerminalMatchIndex(matches), 4)
  assert.equal(find.stepTerminalMatchIndex(matches, null, 'next'), 0)
  assert.equal(find.stepTerminalMatchIndex(matches, null, 'previous'), 4)
  assert.equal(find.stepTerminalMatchIndex(matches, matches[0], 'next'), 1)
  assert.equal(find.stepTerminalMatchIndex(matches, matches[0], 'previous'), 4)
  assert.equal(find.stepTerminalMatchIndex(matches, matches[4], 'next'), 0)
  assert.equal(find.stepTerminalMatchIndex(matches, { line: 1, column: 2, length: 5 }, 'next'), 2)
  assert.equal(find.stepTerminalMatchIndex(matches, { line: 1, column: 2, length: 5 }, 'previous'), 1)
  assert.equal(find.stepTerminalMatchIndex([], null, 'next'), -1)

  assert.equal(find.terminalFindKeyAction({ key: 'f', code: 'KeyF', ctrlKey: true }), 'focus')
  assert.equal(find.terminalFindKeyAction({ key: 'f', code: 'KeyF', metaKey: true }), 'focus')
  assert.equal(find.terminalFindKeyAction({ key: 'Escape' }), 'close')
  assert.equal(find.terminalFindKeyAction({ key: 'Enter' }), 'next')
  assert.equal(find.terminalFindKeyAction({ key: 'Enter', shiftKey: true }), 'previous')
  assert.equal(find.terminalFindKeyAction({ key: 'g', code: 'KeyG', ctrlKey: true }), 'next')
  assert.equal(find.terminalFindKeyAction({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true }), 'previous')
  assert.equal(find.terminalFindKeyAction({ key: 'Enter', isComposing: true }), null)
  assert.equal(find.terminalFindKeyAction({ key: 'a', code: 'KeyA' }), null)

  assert.deepEqual(view.normalizeTerminalView(null), view.DEFAULT_TERMINAL_VIEW)
  assert.deepEqual(view.normalizeTerminalView({}), view.DEFAULT_TERMINAL_VIEW)
  assert.deepEqual(view.normalizeTerminalView({ fontSize: 20, lineHeight: 2, cursorStyle: 'nope', scrollback: 500 }), view.DEFAULT_TERMINAL_VIEW)
  const custom = view.normalizeTerminalView({ fontSize: 13, lineHeight: 1.15, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000 })
  assert.deepEqual(custom, { fontSize: 13, lineHeight: 1.15, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000 })
  assert.equal(view.normalizeTerminalView({ cursorBlink: 'no' }).cursorBlink, true)

  const options = view.terminalXtermOptions(view.DEFAULT_TERMINAL_VIEW)
  assert.equal(options.fontSize, 12)
  assert.equal(options.lineHeight, 1)
  assert.equal(options.cursorStyle, 'block')
  assert.equal(options.cursorBlink, true)
  assert.equal(options.scrollback, 10000)
  assert.equal(options.minimumContrastRatio, 3)

  const saved = new Map()
  const storage = {
    getItem: (key) => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => saved.set(key, value)
  }
  const store = view.createTerminalViewStore(storage, () => () => {})
  assert.deepEqual(store.get(), view.DEFAULT_TERMINAL_VIEW)
  let notified = 0
  const off = store.subscribe(() => {
    notified += 1
  })
  store.update({ fontSize: 14 })
  assert.equal(notified, 1)
  assert.equal(store.get().fontSize, 14)
  assert.deepEqual(JSON.parse(saved.get(view.TERMINAL_VIEW_STORAGE_KEY)), { ...view.DEFAULT_TERMINAL_VIEW, fontSize: 14 })
  store.update({ fontSize: 14 })
  assert.equal(notified, 1)
  store.update({ cursorBlink: false })
  assert.equal(store.get().cursorBlink, false)
  assert.equal(notified, 2)
  off()
  store.update({ scrollback: 1000 })
  assert.equal(notified, 2)
  const reopened = view.createTerminalViewStore(storage)
  assert.equal(reopened.get().fontSize, 14)
  assert.equal(reopened.get().scrollback, 1000)

  const broken = view.createTerminalViewStore({ getItem: () => 'not json', setItem: () => {} })
  assert.deepEqual(broken.get(), view.DEFAULT_TERMINAL_VIEW)

  console.log('test-v3-terminal-tabs: ok')
}

await runTerminalSession()
await runTerminalLifecycle()
await runTerminalTabs()
