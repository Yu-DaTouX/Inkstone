import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

async function load(entry, name) {
  const dir = await mkdtemp(join(tmpdir(), `inkstone-${name}-`))
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'silent' })
  return { module: await import(pathToFileURL(outfile).href), dir }
}

function fakeHost() {
  let now = 0
  let seq = 0
  const timers = new Map()
  const host = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout: (id) => { timers.delete(id) }
  }
  const advance = (ms) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = target
  }
  return { host, advance, get pending() { return timers.size }, get now() { return now } }
}

async function main() {
  const schedulerMod = await load('src/renderer/src/lib/tip-scheduler.ts', 'tip-scheduler')
  const blockersMod = await load('src/renderer/src/state/browser-visibility.ts', 'tip-blockers')
  const { TipScheduler, TIP_FIRST_DELAY_MS, TIP_WARM_DELAY_MS, TIP_WARM_WINDOW_MS, isTipActive } = schedulerMod.module
  const { OverlayBlockers } = blockersMod.module

  eq(TIP_FIRST_DELAY_MS, 400, '首次悬停延迟是 400ms')
  eq(TIP_WARM_DELAY_MS, 0, '热切换延迟是 0ms')
  ok(TIP_WARM_WINDOW_MS > 0, '热窗口为正')

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const id = Symbol('a')
    let shown = 0
    const delay = s.request(id, () => { shown += 1 }, () => {})
    eq(delay, 400, '首次 request 采用 400ms')
    advance(399)
    eq(shown, 0, '399ms 时还没显示')
    advance(1)
    eq(shown, 1, '400ms 时显示')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const a = Symbol('a')
    let shown = 0
    s.request(a, () => { shown += 1 }, () => {})
    advance(200)
    s.cancel(a)
    advance(500)
    eq(shown, 0, '离开后到点也不显示')
    eq(s.hasPending, false, '取消后没有待开定时器')
    const delay = s.request(Symbol('b'), () => { shown += 1 }, () => {})
    eq(delay, 400, '未出现过气泡，下次仍是首次延迟')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const a = Symbol('a')
    s.request(a, () => {}, () => {})
    advance(400)
    ok(s.isVisible(a), 'a 已显示')
    s.release(a)
    ok(!s.isVisible(a), 'release 清掉可见登记')
    const b = Symbol('b')
    let shownB = 0
    const delay = s.request(b, () => { shownB += 1 }, () => {})
    eq(delay, 0, '热状态下相邻切换无首次延迟')
    eq(shownB, 1, '热切换同步显示')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const a = Symbol('a')
    s.request(a, () => {}, () => {})
    advance(400)
    s.release(a)
    advance(TIP_WARM_WINDOW_MS + 1)
    const delay = s.request(Symbol('b'), () => {}, () => {})
    eq(delay, 400, '热窗口过后重新等首次延迟')
  }

  {
    const { host } = fakeHost()
    const s = new TipScheduler(host)
    const id = Symbol('focus')
    let shown = 0
    const delay = s.request(id, () => { shown += 1 }, () => {}, true)
    eq(delay, 0, '聚焦即时返回 0')
    eq(shown, 1, '聚焦同步显示')
    ok(s.isVisible(id), '聚焦后即标记为可见')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const a = Symbol('a')
    const b = Symbol('b')
    let hiddenA = 0
    s.request(a, () => {}, () => { hiddenA += 1 })
    advance(400)
    eq(hiddenA, 0, 'a 显示时不关自己')
    const delay = s.request(b, () => {}, () => {})
    eq(delay, 0, '切到相邻走热延迟')
    eq(hiddenA, 1, '显示 b 时收起 a')
    ok(s.isVisible(b) && !s.isVisible(a), '任一时刻只有一个可见')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const id = Symbol('unmount')
    let shown = 0
    s.request(id, () => { shown += 1 }, () => {})
    ok(s.hasPending, '有待开定时器')
    s.release(id)
    eq(s.hasPending, false, '卸载后待开定时器被清掉')
    advance(1000)
    eq(shown, 0, '卸载后不再显示')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const id = Symbol('stable')
    let shown = 0
    let hidden = 0
    s.request(id, () => { shown += 1 }, () => { hidden += 1 })
    advance(400)
    for (let i = 0; i < 5; i += 1) {
      const delay = s.request(id, () => { shown += 1 }, () => { hidden += 1 })
      eq(delay, 0, '已可见时 request 返回 0')
    }
    eq(shown, 1, '重复 request 不会再次显示（不动画重启）')
    eq(hidden, 0, '重复 request 不会关闭')
    eq(s.hasPending, false, '重复 request 不叠加定时器')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const a = Symbol('a')
    const b = Symbol('b')
    let shownA = 0
    let shownB = 0
    s.request(a, () => { shownA += 1 }, () => {})
    advance(100)
    s.request(b, () => { shownB += 1 }, () => {})
    eq(s.hasPending, true, '只有一个待开定时器')
    advance(1000)
    eq(shownA, 0, '被顶掉的 a 不显示')
    eq(shownB, 1, '最新的 b 显示')
  }

  {
    const { host, advance } = fakeHost()
    const s = new TipScheduler(host)
    const a = Symbol('a')
    let hiddenA = 0
    s.request(a, () => {}, () => { hiddenA += 1 })
    advance(400)
    eq(s.dismiss(), true, '有气泡时 Esc 关掉它')
    eq(hiddenA, 1, 'Esc 调用了关闭回调')
    ok(!s.isVisible(a), 'Esc 后不再是可见')
    eq(s.dismiss(), false, '没有气泡时 Esc 不做事')
    const delay = s.request(Symbol('b'), () => {}, () => {})
    eq(delay, 0, 'Esc 之后相邻悬停走热延迟')
  }

  {
    const blockers = new OverlayBlockers()
    const release = () => { blockers.release('tip') }
    blockers.acquire('tip')
    eq(blockers.size, 1, '领取后占用一个 token')
    blockers.acquire('tip')
    eq(blockers.size, 1, '同一 token 嵌套领取仍算一个')
    blockers.release('tip')
    eq(blockers.has('tip'), true, '嵌套时释放一次还没解除')
    blockers.release('tip')
    eq(blockers.has('tip'), false, '全部释放后解除')
    blockers.release('tip')
    eq(blockers.size, 0, '重复释放不报错也不变负')
    blockers.acquire('other')
    blockers.acquire('tip')
    blockers.release('tip')
    eq(blockers.has('other'), true, '只释放自己的 token，不动别人的')
    release()
    eq(blockers.size, 1, '再次释放不存在的 tip 保持原状')
  }

  {
    ok(isTipActive({ hover: true, focused: false }), '只悬停：保持')
    ok(isTipActive({ hover: false, focused: true }), '只聚焦：保持（键盘立即可见）')
    ok(isTipActive({ hover: true, focused: true }), '两者都有：保持')
    ok(isTipActive({ hover: true, focused: false }), '聚焦中鼠标扫过又离开：仍因悬停保持')
    ok(isTipActive({ hover: false, focused: true }), '悬停中失焦：仍因悬停保持')
    ok(!isTipActive({ hover: false, focused: false }), '都没有：收起')
  }

  await rm(schedulerMod.dir, { recursive: true, force: true })
  await rm(blockersMod.dir, { recursive: true, force: true })
  console.log(`统一提示气泡调度：${checks} 项通过`)
}

await main()
