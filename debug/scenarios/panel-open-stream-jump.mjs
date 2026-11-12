import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const meta = { description: '右栏打开时消息流不应跳动：窗口 1778×958（DPR 1.44，对应 2560×1380 物理像素）、侧栏 200，大会话副本（YAN_LONG_SCROLL_SOURCE）在底部与中部各开一次右栏，逐帧记录离底距离与锚点偏移，不调用模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, runDir }) {
  const source = process.env.YAN_LONG_SCROLL_SOURCE
  if (!source) throw new Error('需要 YAN_LONG_SCROLL_SOURCE 指向测试用会话副本')
  const ev = (expr) => cdp.evaluate(expr)
  const metrics = (width) => cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 958, deviceScaleFactor: 1.44, mobile: false })
  await metrics(1778)
  await ev(`localStorage.setItem('inkstone.v3.sidebarWidth', '200'); location.reload()`).catch(() => {})
  await sleep(4000)
  await waitFor('!!s.settings', 30000)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light', lang: 'zh-CN', workspaceTiles: true, rightPanelOpen: false })`)
  await ev(`window.__yanRightPanel.getState().setOpen(false)`)
  await ev(`(() => { const toggle = document.querySelector('[data-testid="v3-head-sessionbar-toggle"]'); if (toggle?.getAttribute('aria-pressed') === 'true') toggle.click() })()`)
  await sleep(800)

  const dir = join(box.sessionsDir, '--panel-jump-fixture--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, basename(source))
  copyFileSync(source, file)
  report.fixture = { bytes: statSync(file).size }
  await ev(`window.__yanStore.getState().refreshSessions()`)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
  await waitFor(`!s.switchLoading && s.messages.length > 300`, 90000)
  await sleep(2000)

  const watch = (trackId) => ev(`(() => {
    const el = document.querySelector('.v3-stream')
    const w = window.__jumpWatch = { frames: [], trackId: ${JSON.stringify(trackId)} }
    const tick = (now) => {
      const top = el.getBoundingClientRect().top
      const tracked = w.trackId ? [...el.querySelectorAll('.v3-msg[data-turn-id]')].find((r) => r.dataset.turnId === w.trackId) : null
      w.frames.push({ t: Math.round(now), st: Math.round(el.scrollTop), sh: el.scrollHeight, cw: el.clientWidth, fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop), off: tracked ? Math.round(tracked.getBoundingClientRect().top - top) : null })
      w.raf = requestAnimationFrame(tick)
    }
    w.raf = requestAnimationFrame(tick)
  })()`)
  const unwatch = () => ev(`(() => { const w = window.__jumpWatch; cancelAnimationFrame(w.raf); return w.frames })()`)
  const anchorNow = () => ev(`(() => {
    const el = document.querySelector('.v3-stream'); const top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll('.v3-msg[data-turn-id]')].find((r) => r.getBoundingClientRect().bottom > top + 40)
    return { id: row?.dataset.turnId ?? null, offset: row ? Math.round(row.getBoundingClientRect().top - top) : null, fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop), cw: el.clientWidth }
  })()`)

  report.cases = {}
  await ev(`window.__autoApprove || (() => { const st = window.__yanStore; const seen = new Set(); window.__autoApprove = st.subscribe((x) => { try { const list = Array.isArray(x.approvals) ? x.approvals : Object.values(x.approvals ?? {}); for (const a of list) { if (a && a.id && !seen.has(a.id)) { seen.add(a.id); setTimeout(() => void st.getState().answerApproval(a.id, 'session'), 0) } } } catch {} }) })()`)
  const places = [
    ['bottom', async () => { await ev(`(() => { const el = document.querySelector('.v3-stream'); el.scrollTop = el.scrollHeight })()`) }],
    ['running', async () => {
      await ev(`(() => { const el = document.querySelector('.v3-stream'); el.scrollTop = el.scrollHeight })()`)
      await ev(`window.__yanStore.getState().send('MDSHOW CHUNK5 GAP70 写一段很长的说明')`)
      await waitFor(`!!(s.session?.isStreaming || s.session?.isAgentRunning)`, 30000)
      await sleep(3500)
    }],
    ['reading', async () => { await ev(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.62) })()`); await sleep(1500) }]
  ]
  for (const [name, go] of places) {
    await go()
    await sleep(1200)
    const before = await anchorNow()
    await watch(name === 'reading' ? before.id : null)
    await ev(`(() => { window.__shifts = []; window.__shiftObs?.disconnect(); window.__shiftObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__shifts.push({ t: Math.round(e.startTime), value: Number(e.value.toFixed(4)), recent: e.hadRecentInput, sources: e.sources.map((x) => ({ cls: (x.node?.className || x.node?.nodeName || '').toString().slice(0, 40), id: x.node?.dataset?.turnId ?? null, dy: Math.round(x.currentRect.y - x.previousRect.y), h0: Math.round(x.previousRect.height), h1: Math.round(x.currentRect.height) })).slice(0, 4) }) }); window.__shiftObs.observe({ type: 'layout-shift', buffered: false }) })()`)
    const framesDir = join(runDir, 'frames-' + name)
    mkdirSync(framesDir, { recursive: true })
    cdp.events.length = 0
    await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, everyNthFrame: 1 })
    const castStart = Date.now()
    await ev(`document.querySelector('[data-testid="v3-head-panel-toggle"]').click()`)
    let got = 0
    while (Date.now() - castStart < 1500) {
      while (cdp.events.length) {
        const event = cdp.events.shift()
        if (event.method === 'Page.screencastFrame') {
          writeFileSync(join(framesDir, String(got).padStart(3, '0') + '-' + Math.round(event.params.metadata.timestamp * 1000 % 100000) + '.jpg'), Buffer.from(event.params.data, 'base64'))
          got += 1
          cdp.call('Page.screencastFrameAck', { sessionId: event.params.sessionId })
        }
      }
      await sleep(8)
    }
    await cdp.call('Page.stopScreencast')
    report['castFrames_' + name] = got
    await sleep(300)
    const shifts = await ev(`(() => { window.__shiftObs.disconnect(); return window.__shifts })()`)
    const opened = await anchorNow()
    const frames = await unwatch()
    await ev(`document.querySelector('[data-testid="v3-head-panel-toggle"]').click()`)
    await sleep(1500)
    const maxFromBottom = Math.max(...frames.map((f) => f.fromBottom))
    const offs = frames.filter((f) => f.off !== null).map((f) => f.off)
    const missing = frames.filter((f) => f.off === null).length
    const changes = frames.filter((f, i) => i === 0 || f.st !== frames[i - 1].st || f.sh !== frames[i - 1].sh || f.cw !== frames[i - 1].cw).slice(0, 40).map((f) => `${f.t - frames[0].t}ms st=${f.st} sh=${f.sh} cw=${f.cw} fromBottom=${f.fromBottom} off=${f.off}`)
    report.cases[name] = { shifts, before, opened, maxFromBottom, offMin: offs.length ? Math.min(...offs) : null, offMax: offs.length ? Math.max(...offs) : null, missing, frames: frames.length, changes }
    console.log(name, JSON.stringify({ before, opened, maxFromBottom, offMin: report.cases[name].offMin, offMax: report.cases[name].offMax, missing }))
    console.log('layout-shift entries', JSON.stringify(shifts).slice(0, 1500))
    console.log(changes.join('\n'))
    if (name === 'bottom' || name === 'running') check(`底部跟随（${name}）：打开右栏的整个过程中离底距离不超过 80px`, maxFromBottom <= 80, { before, opened, maxFromBottom })
    else {
      check('阅读中：打开右栏的整个过程中锚点回合始终在视口里', missing === 0, { missing, frames: frames.length })
      check('阅读中：打开右栏的整个过程中锚点偏移变化不超过 120px', offs.length > 0 && Math.max(...offs) - Math.min(...offs) <= 120, { offMin: Math.min(...offs), offMax: Math.max(...offs) })
    }
  }
}
