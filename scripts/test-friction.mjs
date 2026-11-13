import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runSuite } from './lib/test-suite.mjs'

const repo = resolve('.')

const electronStub = (root) => ({
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const app={isPackaged:false,getVersion:()=>'9.9.9',getAppPath:()=>${JSON.stringify(repo)},getLocale:()=>'zh-CN',getPath:()=>${JSON.stringify(root)}};export const shell={openPath:async()=>''}`,
      loader: 'js'
    }))
  }
})

await runSuite(import.meta.url, async (ok, compile) => {
  const f = await compile('src/shared/friction.ts')

  const ring = new f.SegmentRing(2)
  ring.push('a1', true)
  ring.push('a2', false)
  ring.push('b1', true)
  ring.push('c1', true)
  ring.push('c2', false)
  ok(JSON.stringify(ring.items()) === JSON.stringify(['b1', 'c1', 'c2']), '环形缓冲只保留最近两段')
  ring.clear()
  ring.push('x', true)
  ok(ring.items().length === 1, '清空后首个检查点不留空段')

  const rage = f.createRageClickDetector({ count: 3, windowMs: 800, radius: 24 })
  ok(!rage(0, 10, 10) && !rage(200, 12, 11), '两次点击不算连点')
  ok(rage(400, 11, 12), '0.8 秒内同一处第三次点击算连点')
  ok(!rage(500, 11, 12), '判定后重新计数')
  const spread = f.createRageClickDetector({ count: 3, windowMs: 800, radius: 24 })
  ok(!spread(0, 0, 0) && !spread(100, 100, 0) && !spread(200, 200, 0), '分散的点击不算连点')
  const slow = f.createRageClickDetector({ count: 3, windowMs: 800, radius: 24 })
  ok(!slow(0, 0, 0) && !slow(500, 0, 0) && !slow(1400, 0, 0), '超出时间窗不算连点')

  const limits = { jumpPx: 120, quietMs: 1000, minViewportPx: 200, bottomSlackPx: 4 }
  const stream = {}
  const jumps = f.createScrollJumpDetector(limits)
  ok(jumps.sample(stream, { at: 0, top: 1000, height: 3000, viewport: 600 }) === null, '首个样本只记录')
  const up = jumps.sample(stream, { at: 100, top: 700, height: 3000, viewport: 600 })
  ok(up && up.from === 1000 && up.to === 700 && !up.wasAtBottom, '无操作时上跳 300px 判为跳变')
  ok(jumps.sample(stream, { at: 200, top: 650, height: 3000, viewport: 600 }) === null, '小幅移动不算')
  jumps.hold(250)
  ok(jumps.sample(stream, { at: 900, top: 100, height: 3000, viewport: 600 }) === null, '用户操作后 1 秒内的大幅滚动不算')
  ok(jumps.sample(stream, { at: 1400, top: 2400, height: 3000, viewport: 600 }) !== null, '静默期过后无操作跳到底部算跳变')
  ok(jumps.sample(stream, { at: 1500, top: 2800, height: 3400, viewport: 600 }) === null, '贴底跟随新内容不算')
  const fromBottom = jumps.sample(stream, { at: 1600, top: 2500, height: 3400, viewport: 600 })
  ok(fromBottom && fromBottom.wasAtBottom, '贴底时被顶上去标记 from-bottom')
  const small = {}
  jumps.sample(small, { at: 0, top: 0, height: 900, viewport: 150 })
  ok(jumps.sample(small, { at: 2000, top: 600, height: 900, viewport: 150 }) === null, '小滚动区不检测')
  ok(f.isFrictionReason('scroll-jump'), 'scroll-jump 是合法原因')

  const allow = f.createTriggerThrottle(60_000, 20_000)
  ok(allow('layout-shift', 0), '首个自动触发放行')
  ok(!allow('long-frame', 10_000), '20 秒内其他类型也不放行')
  ok(allow('long-frame', 25_000), '间隔过后其他类型放行')
  ok(!allow('layout-shift', 50_000), '同类型 60 秒冷却')
  ok(allow('hotkey', 50_001) && allow('hotkey', 50_002), '快捷键不受限流')
  ok(!allow('error', 60_000), '快捷键之后自动触发也要等间隔')

  const day = 24 * 60 * 60 * 1000
  const drop = f.selectFrictionPrune([
    { name: 'old', mtimeMs: 0, bytes: 1 },
    { name: 'a', mtimeMs: 10 * day, bytes: 300 },
    { name: 'b', mtimeMs: 9 * day, bytes: 300 },
    { name: 'c', mtimeMs: 8 * day, bytes: 300 }
  ], 10 * day, { maxAgeMs: 7 * day, maxBytes: 700 })
  ok(JSON.stringify(drop.sort()) === JSON.stringify(['c', 'old']), '超期与超额的旧记录被挑出，新记录保留', JSON.stringify(drop))

  ok(f.frictionDirName(new Date(2026, 10, 14, 3, 4, 5), 'hotkey') === '20261114-030405-hotkey', '目录名按本地时间与原因')

  const key = { code: 'KeyF', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }
  ok(f.isFrictionHotkey(key), 'Ctrl+Alt+F 触发')
  ok(!f.isFrictionHotkey({ ...key, shiftKey: true }), '加 Shift 不触发')
  ok(!f.isFrictionHotkey({ ...key, altGraph: true }), 'AltGr 不触发')
  ok(!f.isFrictionHotkey({ ...key, ctrlKey: false }), '缺 Ctrl 不触发')

  ok(f.sanitizeFrictionRequest({ reason: 'nope', events: [{}] }) === null, '未知原因被拒')
  ok(f.sanitizeFrictionRequest({ reason: 'hotkey', events: [] }) === null, '空事件被拒')
  const clean = f.sanitizeFrictionRequest({
    reason: 'hotkey',
    detail: 'x'.repeat(900),
    events: [{ type: 2 }],
    marks: [{ at: 1, kind: 'hotkey' }, { at: 'bad', kind: 'hotkey' }, { at: 2, kind: 'zzz' }],
    context: { route: 'chat', viewport: { width: 800, height: 600 } }
  })
  ok(clean && clean.detail.length === 500 && clean.marks.length === 1 && clean.context.viewport.width === 800, '请求被清洗：截断说明、丢掉坏标记')

  const root = await mkdtemp(join(tmpdir(), 'inkstone-friction-'))
  try {
    process.env.YAN_DATA_DIR = join(root, 'yan')
    process.env.YAN_PI_DIR = join(root, 'pi')
    const main = await compile('src/main/friction.ts', { packages: 'external', plugins: [electronStub(root)] })
    const store = join(root, 'friction')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const contents = { capturePage: async () => ({ isEmpty: () => false, toPNG: () => png }) }
    const request = { reason: 'hotkey', events: [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }], marks: [{ at: 2, kind: 'hotkey' }], context: { viewport: { width: 1200, height: 800 }, startedAt: 1, capturedAt: 3, privateVisible: false } }

    const off = await main.saveFrictionCapture(contents, request, false, store)
    ok(!off.ok && !existsSync(store), '关闭时不写任何文件')

    const saved = await main.saveFrictionCapture(contents, request, true, store)
    ok(saved.ok && saved.dir && existsSync(saved.dir), '开启时写出记录目录')
    const files = (await readdir(saved.dir)).sort()
    ok(JSON.stringify(files) === JSON.stringify(['events.js', 'meta.json', 'replay.html', 'shot.png']), '记录含事件、元数据、回放页与截图', files.join(','))
    const meta = JSON.parse(await readFile(join(saved.dir, 'meta.json'), 'utf8'))
    ok(meta.reason === 'hotkey' && meta.events === 2 && meta.version === '9.9.9', '元数据写明原因、事件数与版本')
    const eventsJs = await readFile(join(saved.dir, 'events.js'), 'utf8')
    ok(eventsJs.includes('window.__FRICTION_EVENTS__ = [{"type":4'), '事件写成回放页可直接加载的脚本')
    const html = await readFile(join(saved.dir, 'replay.html'), 'utf8')
    ok(html.includes('../_player/rrweb-player.js') && html.includes('events.js'), '回放页引用共享播放器与本目录事件')
    ok(existsSync(join(store, '_player', 'rrweb-player.js')) && existsSync(join(store, '_player', 'rrweb-player.css')), '播放器文件复制到记录根目录')

    const again = await main.saveFrictionCapture(contents, request, true, store)
    ok(again.ok && again.dir !== saved.dir && existsSync(saved.dir), '同一秒再记一次不覆盖上一条')

    const hidden = await main.saveFrictionCapture(contents, { ...request, context: { ...request.context, privateVisible: true } }, true, store)
    ok(hidden.ok && !existsSync(join(hidden.dir, 'shot.png')) && existsSync(join(hidden.dir, 'events.js')), '有私密内容时不截图，只留录像')
    const unknown = await main.saveFrictionCapture(contents, { ...request, context: { viewport: {} } }, true, store)
    ok(unknown.ok && !existsSync(join(unknown.dir, 'shot.png')), '没说明有无私密内容时按有处理')

    const bad = await main.saveFrictionCapture(contents, { reason: 'hotkey', events: 'x' }, true, store)
    ok(!bad.ok && bad.error === 'invalid', '坏请求被拒')

    const stale = join(store, '20200101-000000-error')
    await mkdir(stale)
    await writeFile(join(stale, 'meta.json'), '{}')
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    const pruned = await main.pruneFriction(store)
    ok(pruned.includes('20200101-000000-error') && !existsSync(stale), '超过 7 天的记录被清理')
    ok(existsSync(saved.dir) && existsSync(join(store, '_player')), '新记录与播放器不被清理')
    ok((await stat(join(store, '_player'))).isDirectory(), '播放器目录保留')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
