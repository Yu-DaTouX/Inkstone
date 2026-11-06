import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startProfile, stopProfile } from '../lib/cpu-profile.mjs'
import { FX_HOOK, frameStats, sidebarStats, streamStats, switchStats } from '../lib/sidebar-probes.mjs'

export const meta = { description: '真实数据副本（用 debug/review.mjs 跑）：多会话同时运行时的左栏重排、状态变化、搜索、折叠，以及切会话中间帧；输出逐帧指标，不调用真实模型' }

const LOADS = [
  'SUBAGENTS3 STEPS24 STORM-a',
  'STEPS8 STORM-b',
  'STEPS12 ASK STORM-c'
]

export default async function run({ autoApprove, cdp, waitFor, sleep, log, report, box, newSession, shot, out, sandboxProject }) {
  const ev = (expr) => cdp.evaluate(expr)
  const tag = process.env.YAN_FX_TAG ?? 'run'
  const save = (name, value) => writeFileSync(join(out, `${tag}-${name}.json`), JSON.stringify(value, null, 1))
  await waitFor('s.sessions.length > 0', 60000, 20)
  await sleep(1500)
  await ev(FX_HOOK)
  await ev(`window.__yanStore.getState().patchSettings({ sidebarLayout: ${JSON.stringify(process.env.YAN_FX_LAYOUT ?? 'flat')}, reduceMotion: false })`)
  await sleep(500)

  const profiling = (process.env.YAN_FX_PROFILE ?? '').split(',').filter(Boolean)
  const record = async (name, action, settle = 600, mode = 'sidebar') => {
    const prof = profiling.includes(name)
    if (prof) await startProfile(cdp)
    await ev(`window.__fx.start(${JSON.stringify(prof && process.env.YAN_FX_CLEANPROF ? 'none' : mode)})`)
    await action()
    await sleep(settle)
    const raw = await ev('window.__fx.stop()')
    if (prof) {
      const p = await stopProfile(cdp, out)
      save(`profile-${name}`, { totalMs: p.totalMs, top: p.top, longBusy: p.longBusy })
      log('profile', name, JSON.stringify(p.top.slice(0, 12)))
      log('longBusy', name, JSON.stringify(p.longBusy))
    }
    const stats = mode === 'stream' ? streamStats(raw.frames, raw.shifts, raw.longs) : raw.frames[0]?.rows ? sidebarStats(raw.frames, raw.shifts, raw.longs) : frameStats(raw.frames)
    report.timings[name] = stats
    save(`frames-${name}`, raw)
    log(name, JSON.stringify(stats))
    return stats
  }

  const started = []
  const startOne = async (text, index) => {
    try { await newSession(box.projects[index % 3]) } catch (e) { log('newSession失败', index, await ev('JSON.stringify({ cwd: window.__yanStore.getState().session?.cwd, runners: window.__yanStore.getState().runners.map((r) => [r.id, r.cwd, r.status, r.running]), notices: window.__yanStore.getState().notices.slice(-3) })')); throw e }
    await ev(`window.__yanStore.getState().send(${JSON.stringify(text)})`)
    await waitFor('!!(s.session?.isStreaming || s.session?.isAgentRunning) && !!s.session?.sessionFile', 30000, 20)
    await sleep(300)
    const info = await ev(`({ file: window.__yanStore.getState().session?.sessionFile, id: window.__yanStore.getState().session?.sessionId })`)
    started.push(info)
  }

  const want = (n) => !process.env.YAN_FX_PHASES || process.env.YAN_FX_PHASES.split(',').includes(n)
  if (want('storm') || want('live')) await record('storm-launch', async () => {
    for (const [index, text] of LOADS.entries()) await startOne(text, index)
  }, 500)
  await sleep(500)
  await shot(`${tag}-storm-after-launch`)
  report.started = started

  if (want('storm')) await record('storm-run', async () => {
    await ev(`window.__fx.noop = 1`)
    await sleep(Number(process.env.YAN_FX_IDLE_MS ?? 30000))
  }, 200)
  await shot(`${tag}-storm-during`)

  const allDone = await ev(`window.__yanStore.getState().runners.filter((r) => r.status === 'running' || r.isAgentRunning).length`)
  log('runners still running', allDone)

  if (want('search')) await record('search-type', async () => {
    const el = await ev(`!!document.querySelector('[data-testid="sidebar-search-input"], aside.v3-side input[type="search"], aside.v3-side input')`)
    if (!el) return
    await ev(`(() => { const i = document.querySelector('[data-testid="sidebar-search-input"], aside.v3-side input[type="search"], aside.v3-side input'); i.focus() })()`)
    for (const ch of 'STORM') {
      await cdp.call('Input.insertText', { text: ch })
      await sleep(180)
    }
    await sleep(500)
    for (let i = 0; i < 5; i++) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await sleep(180)
    }
  }, 600)

  if (want('settled')) await record('settled-toggle', async () => {
    for (let i = 0; i < 2; i++) {
      await ev(`document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]')?.click()`)
      await sleep(700)
    }
  }, 300)

  const rowPoint = (key) => ev(`(() => { const el = [...document.querySelectorAll('[data-sidebar-row]')].find((n) => n.dataset.sidebarRow === ${JSON.stringify(key)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const clickRow = async (key) => {
    const pt = await rowPoint(key)
    if (!pt) return false
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...pt })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...pt })
    return true
  }
  const switchOnce = async (name, target, settle = 900) => {
    const prof = profiling.includes(name)
    if (prof) await startProfile(cdp)
    await ev('window.__fx.start("switch")')
    const clicked = target.key && (await rowPoint(target.key)) ? await clickRow(target.key) : (await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target.path)}); true`), false)
    await sleep(settle)
    const raw = await ev('window.__fx.stop()')
    if (prof) {
      const pr = await stopProfile(cdp, out)
      save(`profile-${name}`, { totalMs: pr.totalMs, top: pr.top, longBusy: pr.longBusy })
      log('profile', name, JSON.stringify(pr.top.slice(0, 12)))
      log('longBusy', name, JSON.stringify(pr.longBusy))
    }
    const stats = switchStats(raw.frames, target)
    stats.clicked = clicked
    save(`frames-${name}`, raw)
    return stats
  }
  const summarize = (list) => {
    const med = (key) => { const v = list.map((x) => x[key]).filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
    const max = (key) => Math.max(0, ...list.map((x) => x[key] ?? 0))
    const sum = (key) => list.reduce((a, x) => a + (x[key] ?? 0), 0)
    return { n: list.length, readyMsMedian: med('readyMs'), readyMsMax: max('readyMs'), dtMaxWorst: max('dtMax'), over50: sum('over50'), staleFrames: sum('staleFrames'), blankFrames: sum('blankFrames'), shiftsAfterFirstContent: sum('shiftsAfterFirstContent'), firstContentMsMedian: med('firstContentMs'), providerFlashFrames: sum('providerFlashFrames'), emptyModelFrames: sum('emptyModelFrames'), skeletonVisibleFrames: sum('skeletonVisibleFrames'), contentChanges: sum('contentChanges'), composerChanges: sum('composerChanges'), scrollTopChanges: sum('scrollTopChanges'), unclicked: list.filter((x) => !x.clicked).length }
  }

  if (!started.length) started.push(...LOADS.map(() => ({ file: null, id: 'x' })))
  if ((process.env.YAN_FX_PHASES ?? '').split(',').includes('subagents')) {
    await newSession(box.projects[0])
    await ev(`window.__yanStore.getState().patchSettings({ permissionMode: 'all' })`)
    await record('subagents-grid', async () => {
      await ev(`window.__yanStore.getState().send('SUBAGENTS8-LOOK STEPS30 先派子代理，再继续')`)
      await waitFor('(s.subagents ?? []).filter((a) => a.status === "running").length >= 6', 60000, 50).catch(() => {})
      await sleep(Number(process.env.YAN_FX_SA_MS ?? 14000))
    }, 1500, 'stream')
  }
  const live = started.map((x) => ({ key: 'local:' + x.id, path: x.file, file: x.file }))
  if (want('live')) {
    await clickRow(live[0].key)
    await sleep(800)
    await ev(`window.__yanStore.getState().send('STEPS150 STORM-a2')`)
    await sleep(1500)
  }
  const liveRuns = []
  for (let round = 0; want('live') && round < 3; round++) {
    for (const target of [live[1], live[2], live[0]]) {
      const stats = await switchOnce(`switch-live-${liveRuns.length}`, target)
      liveRuns.push(stats)
      log('switch-live', JSON.stringify({ ...stats, contentChangeSamples: undefined, composerChangeSamples: stats.composerChangeSamples, scrollTopSamples: undefined }))
    }
  }
  if (liveRuns.length) {
    report.timings.switchLive = summarize(liveRuns)
    log('switchLive', JSON.stringify(report.timings.switchLive))
  }

  const cold = await ev(`window.__yanStore.getState().sessions.filter((x) => x.messageCount > 6 && !x.archivedAt).sort((a, b) => b.messageCount - a.messageCount).slice(0, 3).concat(window.__yanStore.getState().sessions.filter((x) => x.archivedAt && x.messageCount > 20).sort((a, b) => b.messageCount - a.messageCount).slice(0, 3)).map((x) => ({ key: 'local:' + x.id, path: x.path, file: x.path, n: x.messageCount }))`)
  log('cold targets', JSON.stringify(cold))
  const coldRuns = []
  for (let round = 0; want('cold') && round < 2; round++) {
    for (const target of cold) {
      if (round === 0) await ev('document.querySelector("[data-testid=sidebar-settled-shelf-toggle]")?.getAttribute("aria-expanded") === "false" && document.querySelector("[data-testid=sidebar-settled-shelf-toggle]").click()')
      const stats = await switchOnce(`switch-cold-${coldRuns.length}`, target, 1500)
      stats.msgs = target.n
      stats.round = round
      coldRuns.push(stats)
      log('switch-cold', JSON.stringify({ ...stats, contentChangeSamples: undefined, scrollTopSamples: undefined }))
    }
  }
  if (coldRuns.length) {
    report.timings.switchCold = summarize(coldRuns.filter((x) => x.round === 0))
    report.timings.switchWarm = summarize(coldRuns.filter((x) => x.round === 1))
    log('switchCold', JSON.stringify(report.timings.switchCold))
    log('switchWarm', JSON.stringify(report.timings.switchWarm))
  }
  save('switch-all', { liveRuns, coldRuns })
  log('done')
}
