import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

const RUNNING = [300, 25, 25, 25, 25, 25, 200, 25, 25, 25, 25, 25]
const WAITING = [600, 50, 50, 50, 50, 50, 400, 50, 50, 50, 50, 50]

function virtualClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms
      for (let guard = 0; guard < 100000; guard += 1) {
        let next = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === null || timer.at < timers.get(next).at)) next = id
        }
        if (next === null) break
        const timer = timers.get(next)
        timers.delete(next)
        now = Math.max(now, timer.at)
        timer.fn()
      }
      now = target
    },
    sleep(ms) {
      now += ms
    }
  }
}

function frameSet(durations, prefix) {
  return {
    frames: durations.map((durationMs, i) => ({ image: `${prefix}${i}`, durationMs })),
    static: `${prefix}static`
  }
}

function fakeAssets() {
  const calls = []
  return {
    calls,
    frames: {
      running: frameSet(RUNNING, 'run'),
      waiting: frameSet(WAITING, 'wait'),
      idle: frameSet([1], 'idle')
    },
    port(state, theme) {
      calls.push(`${theme}:${state}`)
      return this.frames[state]
    }
  }
}

function fakeApplyLog() {
  const applied = []
  return { applied, apply: (image) => applied.push(image) }
}

function createPlayer(mod, { assets, clock, log, theme = 'on-light' }) {
  return mod.createTrayAnimationPlayer({
    assets: (state, t) => assets.port(state, t),
    theme: () => theme,
    apply: log.apply,
    clock
  })
}

function runPlayerTests(mod) {
  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    const player = createPlayer(mod, { assets, clock, log })
    player.setMotionAllowed(true)
    player.setState('running')
    assert.equal(log.applied.at(-1), 'run0', '运行起始显示亮帧')
    assert.equal(clock.pending(), 1, '同一时刻只有一个 timer')
    assert.equal(player.animating(), true)

    clock.advance(290)
    assert.equal(log.applied.filter((x) => x === 'run1').length, 0)
    clock.advance(10)
    assert.equal(log.applied.at(-1), 'run1')
    clock.advance(25 * 5)
    assert.equal(log.applied.at(-1), 'run6', '进入暗停留')
    clock.advance(200)
    assert.equal(log.applied.at(-1), 'run7')
    clock.advance(25 * 5)
    assert.equal(log.applied.at(-1), 'run0')

    player.setState('running')
    player.setMotionAllowed(true)
    assert.equal(clock.pending(), 1, '重复 start 不增 timer')
    player.dispose()
    assert.equal(clock.pending(), 0, 'dispose 清 timer')
  }

  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    const player = createPlayer(mod, { assets, clock, log })
    player.setMotionAllowed(true)
    player.setState('running')
    assert.equal(log.applied.at(-1), 'run0')
    player.setState('waiting')
    assert.equal(log.applied.at(-1), 'wait0', '切到等待立即显示问号亮帧')
    clock.advance(590)
    assert.equal(log.applied.at(-1), 'wait0')
    clock.advance(10)
    assert.equal(log.applied.at(-1), 'wait1')
    assert.equal(clock.pending(), 1)
    player.dispose()
  }

  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    const player = createPlayer(mod, { assets, clock, log })
    player.setMotionAllowed(true)
    player.setState('waiting')
    clock.advance(620)
    player.setMotionAllowed(false)
    assert.equal(log.applied.at(-1), 'waitstatic', '减少动态时停在静态亮帧')
    assert.equal(clock.pending(), 0, '减少动态清 timer')
    assert.equal(player.animating(), false)
    clock.advance(5000)
    assert.equal(log.applied.at(-1), 'waitstatic', '静态后不再换帧')
    player.setMotionAllowed(true)
    assert.equal(log.applied.at(-1), 'wait0', '恢复动态从亮帧重新开始')
    assert.equal(clock.pending(), 1)
    player.dispose()
  }

  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    const player = createPlayer(mod, { assets, clock, log })
    player.setMotionAllowed(true)
    player.setState('running')
    player.setState('idle')
    assert.equal(log.applied.at(-1), 'idlestatic')
    assert.equal(clock.pending(), 0)
    player.dispose()
  }

  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    const player = createPlayer(mod, { assets, clock, log })
    player.setMotionAllowed(true)
    player.setState('running')
    const before = log.applied.length
    clock.sleep(1600)
    clock.advance(0)
    assert.ok(log.applied.length - before <= 2, `跳帧后只 apply 少量帧（实际 ${log.applied.length - before}）`)
    assert.equal(log.applied.at(-1), 'run0')
    player.dispose()
  }

  {
    const clock = virtualClock()
    const log = fakeApplyLog()
    const player = mod.createTrayAnimationPlayer({
      assets: () => undefined,
      theme: () => 'on-light',
      apply: log.apply,
      clock
    })
    player.setMotionAllowed(true)
    player.setState('running')
    assert.equal(log.applied.length, 0, '无素材时不改图（宿主保留静态回退）')
    assert.equal(clock.pending(), 0)

    const bad = mod.createTrayAnimationPlayer({
      assets: () => ({ frames: [] }),
      theme: () => 'on-light',
      apply: log.apply,
      clock
    })
    bad.setMotionAllowed(true)
    bad.setState('waiting')
    assert.equal(clock.pending(), 0, '空帧集不启动 timer')
    player.dispose()
    bad.dispose()
  }

  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    const player = createPlayer(mod, { assets, clock, log })
    player.setMotionAllowed(true)
    player.setState('running')
    const afterStart = assets.calls.length
    clock.advance(1200)
    assert.equal(assets.calls.length, afterStart, 'tick 不重新取素材（不读盘/不建图）')
    assert.ok(clock.pending() <= 1, '仍是单链 timer')
    player.dispose()
  }

  {
    const clock = virtualClock()
    const assets = fakeAssets()
    const log = fakeApplyLog()
    let theme = 'on-light'
    const player = mod.createTrayAnimationPlayer({
      assets: (state, t) => {
        assets.calls.push(`${t}:${state}`)
        return frameSet(RUNNING, t === 'on-dark' ? 'dark' : 'light')
      },
      theme: () => theme,
      apply: log.apply,
      clock
    })
    player.setMotionAllowed(true)
    player.setState('running')
    assert.equal(log.applied.at(-1), 'light0')
    theme = 'on-dark'
    player.refresh()
    assert.equal(log.applied.at(-1), 'dark0', '主题变化后立即换新主题帧')
    assert.equal(clock.pending(), 1)
    player.dispose()
  }
}

function run(runId, phase, overrides = {}) {
  return {
    runId,
    code: overrides.code ?? 'S1',
    kind: 'session',
    sessionId: 's1',
    title: '任务',
    startedAt: 1000,
    phase,
    counts: { tools: 0, edits: 0, errors: 0 }
  }
}

function fakeTray() {
  const state = { image: null, tooltip: '', menu: null, images: [], destroyed: 0 }
  return {
    state,
    setImage: (image) => {
      state.image = image
      state.images.push(image)
    },
    setToolTip: (t) => {
      state.tooltip = t
    },
    setContextMenu: (m) => {
      state.menu = m
    },
    setTitle: () => {},
    on: () => {},
    destroy: () => {
      state.destroyed += 1
    }
  }
}

function runAttentioIntegrationTests(mod) {
  const makeHarness = (runs, overrides = {}) => {
    const clock = virtualClock()
    const tray = fakeTray()
    const assets = fakeAssets()
    let motionAllowed = true
    const state = { runs, hostBusy: false, hostWaiting: false }
    const deps = {
      platform: 'win32',
      snapshot: () => ({ revision: 1, runs: state.runs }),
      hostBusy: () => state.hostBusy,
      hostWaiting: () => state.hostWaiting,
      window: () => undefined,
      trayImage: () => 'static',
      createTray: () => tray,
      language: () => 'zh-CN',
      statuses: () => [],
      showMainWindow: () => {},
      newSession: () => {},
      selectSession: () => {},
      quit: () => {},
      onThemeChange: () => () => {},
      trayAnimationAssets: (s, theme) => assets.port(s, theme),
      trayTheme: () => 'on-light',
      motionAllowed: () => motionAllowed,
      clock,
      ...overrides
    }
    const service = mod.createAttentionService(deps)
    return {
      service,
      tray,
      clock,
      assets,
      state,
      setMotion: (v) => {
        motionAllowed = v
      }
    }
  }

  {
    const h = makeHarness([run('f', { kind: 'failed', at: 10, cause: 'model-error', message: '崩了', seen: false })])
    h.service.ensureTray()
    assert.equal(h.tray.state.image, 'idlestatic', 'failed 不显示问号')
    assert.equal(h.clock.pending(), 0)
    assert.equal(h.service.summary().attentionCount, 1, 'attentionCount 含 failed，但不驱动问号')
    h.service.dispose()
  }

  {
    const h = makeHarness([run('d', { kind: 'done', at: 10, seen: false })])
    h.service.ensureTray()
    assert.equal(h.tray.state.image, 'idlestatic')
    h.service.dispose()
  }

  {
    const h = makeHarness([
      run('r', { kind: 'running', since: 1, activity: 'streaming' }),
      run('w', { kind: 'needs-you', since: 2, request: { id: 'q', type: 'confirm', summary: '确认' } })
    ])
    h.service.ensureTray()
    assert.equal(h.tray.state.image, 'wait0', '等待优先于运行，显示问号')
    assert.equal(h.clock.pending(), 1)
    h.service.dispose()
  }

  {
    const h = makeHarness([run('r', { kind: 'running', since: 1, activity: 'thinking' })])
    h.service.ensureTray()
    assert.equal(h.tray.state.image, 'run0')
    h.clock.advance(300)
    assert.equal(h.tray.state.image, 'run1')
    h.service.dispose()
  }

  {
    const h = makeHarness([run('r', { kind: 'running', since: 1, activity: 'tool' })])
    h.setMotion(false)
    h.service.ensureTray()
    assert.equal(h.tray.state.image, 'runstatic')
    assert.equal(h.clock.pending(), 0)
    h.service.dispose()
  }

  {
    const h = makeHarness([])
    h.state.hostWaiting = true
    h.service.ensureTray()
    assert.equal(h.tray.state.image, 'wait0')
    h.service.dispose()
  }

  {
    const h = makeHarness([run('r', { kind: 'running', since: 1, activity: 'streaming' })])
    h.service.ensureTray()
    assert.equal(h.clock.pending(), 1)
    h.service.dispose()
    assert.equal(h.clock.pending(), 0, 'dispose 清 timer')
    assert.equal(h.tray.state.destroyed, 1)
  }
}

function runAssetStoreTests(mod) {
  const manifest = {
    version: 1,
    sourceHash: 'abc',
    timelines: {
      running: { frames: RUNNING.map((durationMs, index) => ({ index, durationMs })) },
      waiting: { frames: WAITING.map((durationMs, index) => ({ index, durationMs })) }
    },
    themes: {
      'on-light': {
        static: { idle: 'tray-on-light.png', running: 'tray-on-light.png', waiting: 'tray-on-light-waiting.png' },
        running: RUNNING.map((_, i) => `tray-on-light-running-${i}.png`),
        waiting: WAITING.map((_, i) => `tray-on-light-waiting-${i}.png`)
      },
      'on-dark': {
        static: { idle: 'tray-on-dark.png', running: 'tray-on-dark.png', waiting: 'tray-on-dark-waiting.png' },
        running: RUNNING.map((_, i) => `tray-on-dark-running-${i}.png`),
        waiting: WAITING.map((_, i) => `tray-on-dark-waiting-${i}.png`)
      }
    }
  }

  const makeDeps = (overrides = {}) => {
    const created = []
    let reads = 0
    return {
      created,
      reads: () => reads,
      deps: {
        dirs: ['/brand/tray'],
        exists: () => true,
        readFile: () => {
          reads += 1
          return JSON.stringify(manifest)
        },
        createImage: (path) => {
          created.push(path)
          return `img:${path}`
        },
        ...overrides
      }
    }
  }

  {
    const h = makeDeps()
    const store = mod.createTrayAssetStore(h.deps)
    assert.equal(store.load(), true)
    const afterLoad = h.created.length
    assert.ok(afterLoad >= 2 * (RUNNING.length + WAITING.length), '预载两主题的全部帧')
    for (let i = 0; i < 100; i += 1) store.set('running', 'on-light')
    assert.equal(h.created.length, afterLoad, 'set() 不新建图片')
    assert.equal(h.reads(), 1, 'manifest 只读一次')
    const runSet = store.set('running', 'on-light')
    assert.deepEqual(runSet.frames.map((f) => f.durationMs), RUNNING)
    assert.equal(runSet.static, 'img:/brand/tray/tray-on-light.png')
    const idle = store.set('idle', 'on-light')
    assert.equal(idle.static, 'img:/brand/tray/tray-on-light.png')
    assert.equal(store.sourceHash(), 'abc')
    store.dispose()
    assert.equal(store.set('running', 'on-light'), undefined)
  }

  {
    const h = makeDeps({ readFile: () => '{ not json' })
    const store = mod.createTrayAssetStore(h.deps)
    assert.equal(store.load(), false)
    assert.equal(store.set('running', 'on-light'), undefined)
    assert.equal(store.ready(), false)
  }

  {
    const broken = JSON.parse(JSON.stringify(manifest))
    broken.themes['on-light'].running = broken.themes['on-light'].running.slice(0, 3)
    let warned = ''
    const store = mod.createTrayAssetStore({
      dirs: ['/brand/tray'],
      exists: () => true,
      readFile: () => JSON.stringify(broken),
      createImage: (path) => `img:${path}`,
      onWarn: (message) => {
        warned = message
      }
    })
    assert.equal(store.load(), false, '坏 manifest 失败封闭')
    assert.equal(store.set('running', 'on-light'), undefined)
    assert.match(warned, /manifest/)
  }

  {
    const store = mod.createTrayAssetStore({
      dirs: ['/brand/tray'],
      exists: () => false,
      readFile: () => '',
      createImage: () => 'x'
    })
    assert.equal(store.load(), false)
  }
}

export async function runV3TrayAnimationTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-tray-anim-'))
  const outfile = join(dir, 'attention.mjs')
  try {
    await compile('src/main/attention/index.ts', outfile)
    const mod = await import(pathToFileURL(outfile).href)
    runPlayerTests(mod)
    runAttentioIntegrationTests(mod)
    runAssetStoreTests(mod)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

runV3TrayAnimationTests()
  .then(() => console.log('v3 tray animation：全部通过'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
