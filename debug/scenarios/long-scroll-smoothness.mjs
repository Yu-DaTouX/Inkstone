import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startProfile, stopProfile } from '../lib/cpu-profile.mjs'
import { SCROLL_HOOK, scrollStats, trackStats } from '../lib/scroll-probes.mjs'

export const meta = { description: '真实数据副本（配 --days 0 --include-sessions <片段>，YAN_SCROLL_SESSION 指定片段）：大会话切入、滚轮上下滚、大纲跳转、查找跳转、回到底部、过程区展开的逐帧位移/白屏/长帧，不调用模型' }

export default async function run({ cdp, waitFor, report, sleep, log, shot, out }) {
  const ev = (expr) => cdp.evaluate(expr)
  const tag = process.env.YAN_SCROLL_TAG ?? 'run'
  const fragment = process.env.YAN_SCROLL_SESSION ?? '01a186fd'
  const want = (name) => !process.env.YAN_SCROLL_PHASES || process.env.YAN_SCROLL_PHASES.split(',').includes(name)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor('s.sessions.length > 0', 60000, 20)
  await ev(SCROLL_HOOK)
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false, workspaceTiles: true })`)
  const file = await ev(`(window.__yanStore.getState().sessions.find((x) => x.path.includes(${JSON.stringify(fragment)})) || {}).path`)
  if (!file) throw new Error('找不到会话 ' + fragment)
  report.file = file
  const record = async (name, action, settle = 700) => {
    const prof = (process.env.YAN_SCROLL_PROFILE ?? '').split(',').includes(name)
    if (prof) await startProfile(cdp)
    const trace = (process.env.YAN_SCROLL_TRACE ?? '').split(',').includes(name)
    if (trace) await cdp.call('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' })
    await ev('window.__sp.start()')
    const t = Date.now()
    await action()
    await sleep(settle)
    const raw = await ev('window.__sp.stop()')
    if (trace) {
      await cdp.call('Tracing.end')
      while (!cdp.events.some((e) => e.method === 'Tracing.tracingComplete')) await sleep(50)
      const handle = cdp.events.find((e) => e.method === 'Tracing.tracingComplete').params.stream
      let text = ''
      for (;;) {
        const chunk = (await cdp.call('IO.read', { handle })).result
        text += chunk.data
        if (chunk.eof) break
      }
      await cdp.call('IO.close', { handle })
      writeFileSync(join(out, `${tag}-${name}-trace.json`), text)
    }
    if (prof) {
      const p = await stopProfile(cdp, out)
      writeFileSync(join(out, `${tag}-${name}-profile.json`), JSON.stringify({ top: p.top, longBusy: p.longBusy }, null, 1))
      log('profile', name, JSON.stringify(p.top.slice(0, 12)))
      log('longBusy', name, JSON.stringify(p.longBusy))
    }
    const stats = { ...scrollStats(raw), ...trackStats(raw), ms: Date.now() - t }
    report.timings[name] = stats
    writeFileSync(join(out, `${tag}-${name}.json`), JSON.stringify(raw))
    log(name, stats)
    return stats
  }
  const point = () => ev(`(() => { const r = document.querySelector('.v3-stream').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const clickTrack = async () => {
    const p = await ev(`(() => { const r = window.__spTrack.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 })
  }
  const wheel = async (deltaY, count, gap = 16) => {
    const p = await point()
    for (let i = 0; i < count; i++) {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY })
      await sleep(gap)
    }
  }

  await record('open', async () => {
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
    await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(file)} && s.messages.length > 20`, 120000, 10)
  }, 1500)
  report.messages = await ev('window.__yanStore.getState().messages.length')
  log('messages', report.messages)
  await shot(`${tag}-open`)

  await cdp.call('Performance.enable')
  const mem = async () => { await cdp.call('HeapProfiler.collectGarbage').catch(() => {}); await sleep(300); const m = Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value])); return { heapMB: Math.round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes } }
  if (want('stream')) {
    report.memOpen = await mem()
    log('mem open', report.memOpen)
    await record('stream', async () => {
      await ev(`window.__yanStore.getState().send('STEPS12 STORM-big')`)
      await waitFor('!(s.session?.isStreaming || s.session?.isAgentRunning)', 25000, 50).catch(() => {})
    }, 1500)
    report.memStream = await mem()
    log('mem stream', report.memStream)
  }
  if (want('up')) {
    await record('wheel-up', () => wheel(-120, 120), 800)
    await record('wheel-up-fast', () => wheel(-400, 100, 8), 800)
  }
  if (want('down')) await record('wheel-down', () => wheel(120, 120), 800)
  if (want('jump')) {
    await record('jump-latest', async () => {
      await ev(`document.querySelector('[data-testid="v3-jump"]')?.click()`)
    }, 2500)
  }
  if (want('nav')) {
    const n = await ev(`document.querySelectorAll('[data-testid="v3-outline-tick"]').length`)
    log('outline ticks', n)
    for (const [name, frac] of [['nav-far', .35], ['nav-mid', .6], ['nav-top', 0]]) {
      const index = Math.floor((n - 1) * frac)
      await record(name, async () => {
        await ev(`document.querySelector('[data-testid="v3-outline-tick"][data-index="${index}"]')?.click()`)
      }, 2500)
    }
  }
  if (want('process')) {
    const n = await ev(`document.querySelectorAll('[data-testid="v3-outline-tick"]').length`)
    await ev(`document.querySelector('[data-testid="v3-outline-tick"][data-index="${Math.floor((n - 1) * .5)}"]')?.click()`)
    await sleep(3500)
    log('toggles', await ev(`JSON.stringify({ n: ${n}, box: document.querySelector('.v3-stream').getBoundingClientRect().top, vh: innerHeight, t: [...document.querySelectorAll('[data-testid="v3-process-toggle"]')].map((e) => Math.round(e.getBoundingClientRect().top)) })`))
    for (let round = 0; round < 3; round++) {
      await ev(`(() => {
        const st = document.querySelector('.v3-stream'); const box = st.getBoundingClientRect()
        const list = [...document.querySelectorAll('[data-testid="v3-process-toggle"]')].map((el) => el.getBoundingClientRect().top - box.top).filter((t) => t > 380 || t < 20)
        const want = list.sort((x, y) => Math.abs(x - 300) - Math.abs(y - 300))[0]
        if (want !== undefined) st.scrollTop += want - 300
      })()`)
      await sleep(700)
      const found = await ev(`(() => {
        const box = document.querySelector('.v3-stream').getBoundingClientRect()
        const cands = [...document.querySelectorAll('[data-testid="v3-process-toggle"]')].map((el) => ({ el, r: el.getBoundingClientRect() })).filter((c) => c.r.top > box.top + 80 && c.r.bottom < box.bottom - 120)
        const pick = cands[0]
        if (!pick) return null
        window.__spTrack = pick.el
        return { open: pick.el.getAttribute('aria-expanded'), top: Math.round(pick.r.top - box.top) }
      })()`)
      log('process toggle', found)
      if (found) log('expanded?', await ev(`window.__spTrack.getAttribute('aria-expanded')`))
      if (!found) break
      await record('process-open-' + round, async () => { await clickTrack() }, 900)
      await record('process-close-' + round, async () => { await clickTrack() }, 900)
      await ev('window.__spTrack = null')
      await ev(`document.querySelector('.v3-stream').scrollTop += 900`)
      await sleep(500)
    }
  }
  if (want('find')) {
    await record('find', async () => {
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
      await sleep(300)
      await ev(`(() => { const i = document.querySelector('[data-testid="v3-session-find"]'); i && i.focus() })()`)
      await cdp.call('Input.insertText', { text: process.env.YAN_SCROLL_FIND ?? '修复' })
      await sleep(1200)
      for (let i = 0; i < 4; i++) {
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await sleep(500)
      }
    }, 800)
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  }
  if (want('reload')) {
    const other = await ev(`(window.__yanStore.getState().sessions.find((x) => x.path !== ${JSON.stringify(file)} && x.messageCount > 8) || {}).path`)
    if (other) {
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(other)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(other)} && s.messages.length > 0`, 60000, 10)
      await sleep(1000)
    }
    const switchTimes = []
    await record('reopen', async () => {
      const t0 = Date.now()
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(file)} && s.messages.length > 20`, 120000, 10)
      switchTimes.push(Date.now() - t0)
    }, 1500)
    log('switchMs', switchTimes)
    report.switchMs = switchTimes
  }
}
