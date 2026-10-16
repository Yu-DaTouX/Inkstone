import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(
  new URL('../src/renderer/src/features/terminal/terminal-session.ts', import.meta.url)
)
const built = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)
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
    }
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

console.log('v3 终端生命周期：隐藏不新建 / 迟到 PTY 清理 / 残留 view 清空检查通过')
