import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const meta = { description: '实际长会话副本：导航远跳和长距离滚动的帧间隔、长任务与 CPU，需 YAN_LONG_SCROLL_SOURCE，不调用模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot }) {
  const source = process.env.YAN_LONG_SCROLL_SOURCE
  if (!source) throw new Error('需要 YAN_LONG_SCROLL_SOURCE 指向测试用会话副本')
  const dir = join(box.sessionsDir, '--long-scroll-fixture--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, basename(source))
  copyFileSync(source, file)
  report.fixture = { bytes: statSync(file).size }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1778, height: 958, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', workspaceTiles: true })`)
  await cdp.evaluate(`window.__yanStore.getState().refreshSessions()`)
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  await waitFor(`!s.switchLoading && s.messages.length > 500`, 60000)
  await sleep(1200)
  console.log('navigation state', JSON.stringify(await cdp.evaluate(`({ ticks: document.querySelectorAll('[data-testid="v3-outline-tick"]').length, rail: !!document.querySelector('.v3-rail'), users: window.__yanStore.getState().messages.filter(m=>m.role==='user').length, body: document.querySelector('.v3-session')?.getAttribute('data-view-key') })`)))
  report.fixture.messages = await cdp.evaluate('window.__yanStore.getState().messages.length')
  report.fixture.users = await cdp.evaluate(`window.__yanStore.getState().messages.filter(m=>m.role==='user').length`)
  report.fixture.navigationItems = await cdp.evaluate(`document.querySelectorAll('[data-testid="v3-outline-tick"]').length`)
  check('已载入截图对应的 147 轮长会话', report.fixture.users === 147, report.fixture)
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]))
  const phase = async (name, action, settleMs = 3000) => {
    await cdp.evaluate(`(() => {
      window.__longScroll = { frames: [], tasks: [], offsets: [document.querySelector('.v3-stream').scrollTop], scrolls: 0, maxMountedRows: 0, start: performance.now() };
      let last;
      const tick = now => { window.__longScroll.maxMountedRows = Math.max(window.__longScroll.maxMountedRows, document.querySelectorAll('.v3-stream-row').length); if (last !== undefined) window.__longScroll.frames.push(now - last); last = now; window.__longScroll.frame = requestAnimationFrame(tick) };
      window.__longScroll.frame = requestAnimationFrame(tick);
      window.__longScroll.onScroll = event => { window.__longScroll.scrolls++; window.__longScroll.offsets.push(event.currentTarget.scrollTop) };
      document.querySelector('.v3-stream').addEventListener('scroll', window.__longScroll.onScroll, { capture: true, passive: true });
      window.__longScroll.observer = new PerformanceObserver(list => window.__longScroll.tasks.push(...list.getEntries().map(e => e.duration)));
      window.__longScroll.observer.observe({ type: 'longtask' });
    })()`)
    const before = await metrics()
    await cdp.call('Profiler.enable')
    await cdp.call('Profiler.start')
    if (process.env.YAN_SCROLL_TRACE && name === 'navTop') await cdp.call('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline.cssSelectorStats', transferMode: 'ReturnAsStream' })
    await action()
    await sleep(settleMs)
    if (process.env.YAN_SCROLL_TRACE && name === 'navTop') {
      await cdp.call('Tracing.end')
      while (!cdp.events.some(e => e.method === 'Tracing.tracingComplete')) await sleep(50)
      const stream = cdp.events.find(e => e.method === 'Tracing.tracingComplete').params.stream
      let trace = ''
      for (;;) {
        const chunk = (await cdp.call('IO.read', { handle: stream })).result
        trace += chunk.data
        if (chunk.eof) break
      }
      await cdp.call('IO.close', { handle: stream })
      writeFileSync(process.env.YAN_SCROLL_TRACE, trace)
    }
    const profile = (await cdp.call('Profiler.stop')).result.profile
    const after = await metrics()
    const data = await cdp.evaluate(`(() => {
      const data = window.__longScroll;
      cancelAnimationFrame(data.frame); data.observer.disconnect();
      const el = document.querySelector('.v3-stream'); el.removeEventListener('scroll', data.onScroll, { capture: true });
      const sorted = [...data.frames].sort((a,b) => a-b);
      return { maxMountedRows: data.maxMountedRows, frames: sorted.length, p95Ms: sorted[Math.floor(sorted.length*.95)] ?? 0, maxMs: Math.max(0,...sorted), over33: sorted.filter(n=>n>33.4).length, over50: sorted.filter(n=>n>50).length, longTasks: data.tasks.length, maxTaskMs: Math.max(0,...data.tasks), scrolls: data.scrolls, offsets: data.offsets, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, mounted: el.querySelectorAll('.v3-msg').length };
    })()`)
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']) data[key] = (after[key] - before[key]) * (key.endsWith('Duration') ? 1000 : 1)
    const counts = new Map()
    const nodes = new Map(profile.nodes.map(node => [node.id, node]))
    for (const id of profile.samples ?? []) {
      const frame = nodes.get(id)?.callFrame
      const key = `${frame.functionName || '(anonymous)'} @ ${frame.url?.split('/').at(-1) ?? ''}:${frame.lineNumber + 1}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    data.cpuTop = [...counts].sort((a,b)=>b[1]-a[1]).slice(0, 20)
    report.timings[name] = data
    console.log(name, JSON.stringify({ ...data, offsets: data.offsets.length }))
    return data
  }
  const jump = index => cdp.evaluate(`document.querySelector('[data-testid="v3-outline-tick"][data-index="${index}"]').click()`)
  const target = index => cdp.evaluate(`(() => {
    const el = document.querySelector('.v3-stream'); const base = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll('.v3-msg.user')].map(node => ({ id: node.dataset.turnId, top: node.getBoundingClientRect().top - base }));
    return { active: document.querySelector('[data-testid="v3-outline-tick"][aria-current="location"]')?.getAttribute('data-index'), rows: row, expected: ${index} };
  })()`)
  const topMotion = await phase('navTop', () => jump(3))
  report.navTop = await target(3)
  check('顶部导航到达目标回合', report.navTop.active === '3', report.navTop)
  const intermediatePositions = motion => {
    const from = motion.offsets[0], to = motion.scrollTop, distance = Math.abs(to-from);
    return motion.offsets.filter(offset => Math.abs(offset-from) > distance*.2 && Math.abs(offset-from) < distance*.8).length;
  }
  check('远跳顶部时经过中间滚动位置', intermediatePositions(topMotion) >= 3, intermediatePositions(topMotion))
  check('顶部导航期间保留虚拟化', topMotion.maxMountedRows <= 16, topMotion.maxMountedRows)
  await shot('nav-top')
  const farIndex = Math.floor((report.fixture.navigationItems - 1) * .82)
  const farMotion = await phase('navFar', () => jump(farIndex))
  report.navFar = await target(farIndex)
  check('远距离导航到达目标回合', report.navFar.active === String(farIndex), report.navFar)
  check('远距离导航保留全程滚动过程', intermediatePositions(farMotion) >= 3, intermediatePositions(farMotion))
  check('远距离导航期间保留虚拟化', farMotion.maxMountedRows <= 16, farMotion.maxMountedRows)
  await phase('longScroll', async () => {
    const point = await cdp.evaluate(`(() => { const r = document.querySelector('.v3-stream').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    await cdp.call('Input.synthesizeScrollGesture', { ...point, yDistance: 55000, speed: 55000, gestureSourceType: 'mouse', preventFling: true })
  })
  await phase('scrollSweep', async () => {
    for (let i=0; i<25; i++) {
      await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true })); el.scrollTop += 420 })()`)
      await sleep(20)
    }
  }, 700)
  check('长距离滚动后消息仍挂载', await cdp.evaluate(`document.querySelectorAll('.v3-stream .v3-msg').length > 0`))
  await shot('long-scroll-final')
  await phase('navWarm', () => jump(3))
  check('重复导航仍到达目标回合', (await target(3)).active === '3')
  const railPoint = await cdp.evaluate(`(() => { const r = document.querySelector('.v3-rail').getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...railPoint })
  await sleep(250)
  check('悬停展开导航后当前项可见', await cdp.evaluate(`(() => {
    const rail = document.querySelector('.v3-rail[data-open]');
    const list = rail?.querySelector('.v3-rail-list'); const active = list?.querySelector('[data-current]');
    if (!list || !active) return false;
    const r = active.getBoundingClientRect(); const box = list.getBoundingClientRect();
    return r.top >= box.top-1 && r.bottom <= box.bottom+1;
  })()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 450 })
  await sleep(350)
  await jump(farIndex)
  await sleep(20)
  const wheelPoint = await cdp.evaluate(`(() => { const r = document.querySelector('.v3-stream').getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -800 })
  await sleep(350)
  const interruptedTop = await cdp.evaluate(`document.querySelector('.v3-stream').scrollTop`)
  await sleep(650)
  const interruptedAfter = await cdp.evaluate(`document.querySelector('.v3-stream').scrollTop`)
  check('滚轮打断导航后不会被旧导航拉回', Math.abs(interruptedTop - interruptedAfter) <= 2, { interruptedTop, interruptedAfter })
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await jump(15)
  await sleep(650)
  check('减少动效模式仍能直接导航到目标', (await target(15)).active === '15')
  await cdp.call('Emulation.setEmulatedMedia', { features: [] })
  await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true })); el.scrollTop += 300 })()`)
  await sleep(250)
  const reading = await cdp.evaluate(`(() => {
    const el = document.querySelector('.v3-stream'); const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll('.v3-msg[data-turn-id]')].find(row => row.getBoundingClientRect().bottom > top);
    return { id: row.dataset.turnId, offset: row.getBoundingClientRect().top - top };
  })()`)
  await cdp.evaluate(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(box.project)} })`)
  await waitFor('s.messages.length === 0', 30000)
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  await waitFor('!s.switchLoading && s.messages.length > 500', 60000)
  await sleep(900)
  const restored = await cdp.evaluate(`(() => {
    const el = document.querySelector('.v3-stream'); const row = el.querySelector('[data-turn-id="${reading.id}"]');
    return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  })()`)
  check('切回长会话后恢复原阅读位置', restored !== null && Math.abs(restored - reading.offset) <= 2, { before: reading.offset, after: restored })
  check('会话消息数未改变', await cdp.evaluate('window.__yanStore.getState().messages.length') === report.fixture.messages)
}
