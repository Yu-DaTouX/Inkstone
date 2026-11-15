import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROBES, RENDER_HOOK, RENDER_START, RENDER_TAKE, SUMMARY, useRealWindow } from '../lib/perf-probes.mjs'
import { cpuByKind, memoryByKind, sampleProcessTree } from '../lib/process-tree.mjs'
import { startProfile, stopProfile } from '../lib/cpu-profile.mjs'

export const meta = { description: '子代理群压测：一个后台会话跑 STORM，当前会话派 20 个假模型子代理（SUBLONG，每步流出约 20KB 长文）后继续 STORM；分阶段量渲染进程主线程忙碌比例、长帧、每秒 store 写入与 IPC 推送条数和字节、各进程 CPU，抓 CPU 剖面列热点（YAN_SWARM_PANEL_ONLY=1 只测记录面板），统计组件渲染次数，再打开一个子代理记录面板看它是否流畅更新，并核对渲染端子代理记录与主进程一致（YAN_SWARM_COUNT 改子代理数，YAN_SWARM_MS 改每段时长，YAN_SWARM_LONG=0 关长文，YAN_SWARM_TASK_PAD=<n> 给每个子代理的任务文本补 n 个字符）' }

const PUSH_COUNTER = `(() => {
  if (window.__pushRec) return
  const rec = window.__pushRec = { phase: 'boot', by: {}, span: {} }
  let tick = 0
  const sizeOf = (m) => { try { return JSON.stringify(m.payload).length } catch { return 0 } }
  window.yan.onPush((m) => {
    const slot = (rec.by[rec.phase] ??= {})
    const c = (slot[m.ch] ??= { n: 0, sampled: 0, bytes: 0 })
    c.n++
    if ((tick++ % 10) === 0) { c.sampled++; c.bytes += sizeOf(m) }
  })
})()`

const SET_PHASE = (name) => `(() => {
  const now = performance.now()
  const rec = window.__pushRec
  if (rec.phase !== 'between' && rec.span[rec.phase]) rec.span[rec.phase].end = now
  rec.phase = ${JSON.stringify(name)}
  window.__pa.phase = ${JSON.stringify(name)}
  if (${JSON.stringify(name)} !== 'between') rec.span[${JSON.stringify(name)}] = { start: now, end: now }
  return now
})()`

const PANE_RECORDER = `(() => {
  const el = document.querySelector('[data-testid="v3-subagent-pane"] .sa-pane-stream')
  const sig = () => { const paras = el ? el.querySelectorAll('.v3-para') : []; return paras.length + ':' + (paras.length ? paras[paras.length - 1].textContent.length : 0) }
  const rec = window.__paneRec = { on: true, at: [], first: sig() }
  if (!el) return
  const observer = new MutationObserver(() => { if (rec.on) rec.at.push(performance.now()) })
  observer.observe(el, { subtree: true, childList: true, characterData: true })
  rec.stop = () => { rec.on = false; observer.disconnect(); rec.last = sig() }
})()`

const CONSISTENCY = `(async () => {
  const st = window.__yanStore.getState()
  const out = { compared: 0, runs: 0, mismatches: [] }
  for (const run of st.subagents.filter((a) => a.transcript.length > 0).slice(-8)) {
    const full = await window.yan.subagents.get(run.id)
    if (!full) continue
    out.runs++
    const byId = new Map(full.transcript.map((m) => [m.id, m]))
    for (const msg of run.transcript) {
      const other = byId.get(msg.id)
      if (!other) continue
      out.compared++
      if (!(other.text ?? '').startsWith(msg.text ?? '') || !(other.thinking ?? '').startsWith(msg.thinking ?? '') || (other.toolCalls?.length ?? 0) < (msg.toolCalls?.length ?? 0)) out.mismatches.push({ id: run.id, msg: msg.id, mine: (msg.text ?? '').length, main: (other.text ?? '').length })
    }
  }
  return out
})()`

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  const count = Math.max(1, Math.min(24, Number(process.env.YAN_SWARM_COUNT ?? 20)))
  const windowMs = Math.max(3000, Number(process.env.YAN_SWARM_MS ?? 10000))
  const long = process.env.YAN_SWARM_LONG !== '0'
  const taskPad = Math.max(0, Number(process.env.YAN_SWARM_TASK_PAD ?? 0))
  report.variant = { count, windowMs, long, taskPad }
  const marker = box.userData
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: RENDER_HOOK })
  report.viewport = await useRealWindow(cdp, sleep)
  await cdp.call('Page.reload')
  await sleep(300)
  await waitFor('!!window.__yanStore && !!window.yan && !!document.querySelector(".ProseMirror")', 60000, 20)
  await waitFor('s.conn === "ready"', 60000, 50)
  await ev(PROBES)
  await ev(PUSH_COUNTER)
  await autoApprove()
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))

  const phase = async (name, action, { renders = false, profile = false } = {}) => {
    const procBefore = sampleProcessTree(marker)
    const before = await metrics()
    if (renders) await ev(RENDER_START)
    if (profile) await startProfile(cdp)
    const started = await ev(SET_PHASE(name))
    const out = (await action()) ?? {}
    const ended = await ev(SET_PHASE('between'))
    const ms = Math.max(1, ended - started)
    if (profile) {
      const { totalMs, top, longBusy, profile: raw } = await stopProfile(cdp, runDir, 30)
      writeFileSync(join(runDir, `${name}.cpuprofile`), JSON.stringify(raw))
      out.profile = { totalMs, top, longBusy }
    }
    const after = await metrics()
    const procAfter = sampleProcessTree(marker)
    const wall = Math.max(1, procAfter.at - procBefore.at)
    const take = renders ? await ev(RENDER_TAKE) : null
    const summary = await ev(SUMMARY(name))
    const pushes = await ev(`window.__pushRec.by[${JSON.stringify(name)}] ?? {}`)
    const sec = ms / 1000
    const perSec = Object.fromEntries(Object.entries(pushes).sort((a, b) => b[1].n - a[1].n).map(([ch, c]) => [ch, { perSec: Math.round(c.n / sec), kbPerSec: c.sampled ? Math.round((c.bytes / c.sampled) * c.n / sec / 1024) : 0, avgBytes: c.sampled ? Math.round(c.bytes / c.sampled) : 0 }]))
    const busy = {}
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) busy[key] = Math.round((after[key] - before[key]) * 1000)
    const result = {
      ms: Math.round(ms),
      ...out,
      mainThreadBusyPct: Math.round((busy.TaskDuration / wall) * 100),
      rendererMs: busy,
      frames: summary.frames,
      longTasks: summary.longTasks,
      longTaskMax: summary.longTaskMax,
      storeWritesPerSec: Math.round(summary.storeUpdates / sec),
      changedKeysPerSec: Object.fromEntries(Object.entries(summary.changedKeys).map(([k, n]) => [k, Math.round(n / sec)])),
      pushesPerSec: Math.round(Object.values(pushes).reduce((a, c) => a + c.n, 0) / sec),
      pushes: perSec,
      ipcRtt: summary.ipc,
      processCpuPercent: cpuByKind(procBefore, procAfter),
      memory: memoryByKind(procAfter),
      ...(take ? { renders: take.renders, causes: take.causes } : {})
    }
    report.timings[name] = result
    log(name, JSON.stringify({ ms: result.ms, busy: result.mainThreadBusyPct, frames: result.frames, longTasks: result.longTasks, longTaskMax: result.longTaskMax, store: result.storeWritesPerSec, pushes: result.pushesPerSec, cpu: result.processCpuPercent, top: Object.entries(perSec).slice(0, 4) }))
    if (out.profile) log(name + ' profile', JSON.stringify(out.profile.top.slice(0, 15)))
    if (take) log(name + ' renders', JSON.stringify(take.renders))
    return result
  }

  const background = box.projects[1] ?? box.project
  const foreground = box.projects[0] ?? box.project
  await newSession(background)
  await ev(`window.__yanStore.getState().send('STORM-BG STEPS200 后台会话持续输出')`)
  await waitFor(`${running} && !!s.session?.sessionId`, 30000, 20)
  const bgId = await state('s.session.sessionId')
  await newSession(foreground)
  await ev(`window.__yanStore.getState().send(${JSON.stringify(`SUBAGENTS${count}-FG ${long ? 'SUBLONG ' : ''}${taskPad ? `SUBPAD${taskPad} ` : ''}当前会话派子代理后继续`)})`)
  await waitFor(`${running} && !!s.session?.sessionId`, 30000, 20)
  const fgId = await state('s.session.sessionId')
  report.sessions = { bgId, fgId }
  await waitFor(`s.subagents.filter((a) => a.status === 'running').length >= ${Math.ceil(count * 0.8)}`, 180000, 200)
  await sleep(5000)
  const bgRunning = await ev(`window.__yanStore.getState().runners.some((r) => r.sessionId === ${JSON.stringify(bgId)} && (r.running || r.waiting))`)
  check('后台会话仍在流式输出', bgRunning)
  log('running subagents', await state(`s.subagents.filter((a) => a.status === 'running').length`))

  const panelOnly = process.env.YAN_SWARM_PANEL_ONLY === '1'
  if (!panelOnly) await phase('swarm-watch', () => sleep(windowMs))
  await shot('swarm-watch')
  const cards = await ev(`document.querySelectorAll('[data-testid="v3-subagent-row"], [data-testid="v3-subagent-tile"]').length`)
  check('子代理卡片在消息流里显示', cards >= Math.min(count, 12), { cards })
  const activity = await ev(`[...document.querySelectorAll('[data-testid="v3-subagent-tile"] .v3-sa-tile-detail')].map((el) => el.textContent).join('|')`)
  await sleep(1500)
  const activityLater = await ev(`[...document.querySelectorAll('[data-testid="v3-subagent-tile"] .v3-sa-tile-detail')].map((el) => el.textContent).join('|')`)
  check('子代理卡片上的最近动作在更新', activity !== activityLater)

  if (!panelOnly) {
    await phase('swarm-profile', () => sleep(Math.min(windowMs, 8000)), { profile: true })
    await phase('swarm-renders', () => sleep(5000), { renders: true })
  }

  const consistency = await ev(CONSISTENCY)
  report.consistency = consistency
  check('渲染端子代理记录与主进程一致', consistency.compared > 0 && consistency.mismatches.length === 0, { runs: consistency.runs, compared: consistency.compared, mismatches: consistency.mismatches.slice(0, 5) })

  const target = await state(`s.subagents.find((a) => a.status === 'running' && a.parentSessionId === ${JSON.stringify(fgId)})?.id ?? s.subagents.find((a) => a.status === 'running')?.id ?? null`)
  check('有运行中的子代理可打开记录面板', !!target, target)
  if (target) {
    await ev(`document.querySelector('[data-run-id="${target}"]')?.click()`)
    await waitFor(`!!document.querySelector('[data-testid="v3-subagent-pane"]')`, 10000, 50)
    await sleep(800)
    await ev(PANE_RECORDER)
    const pane = await phase('swarm-panel', () => sleep(windowMs), panelOnly ? { profile: true, renders: true } : {})
    const rec = await ev(`(() => { const r = window.__paneRec; r.stop?.(); const gaps = r.at.slice(1).map((t, i) => t - r.at[i]).sort((a, b) => a - b); return { changes: r.at.length, first: r.first, last: r.last, p50Gap: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null, p95Gap: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)]) : null, maxGap: gaps.length ? Math.round(gaps.at(-1)) : null } })()`)
    pane.paneUpdates = rec
    log('pane updates', rec)
    check('打开的子代理记录面板持续更新', rec.changes >= Math.round(windowMs / 1000) * 5 && rec.last !== rec.first, rec)
    await shot('swarm-panel')
    await phase('swarm-panel-profile', () => sleep(5000), { profile: true, renders: true })
  }

  await ev(`window.yan.subagents.stopAll()`)
  await waitFor(`!s.subagents.some((a) => a.status === 'running' || a.status === 'starting')`, 60000, 200)
  await sleep(500)
  const final = await ev(`(async () => {
    const st = window.__yanStore.getState()
    const listed = await window.yan.subagents.list()
    const byId = new Map(listed.map((r) => [r.id, r]))
    return st.subagents.map((r) => ({ id: r.id, status: r.status, same: byId.get(r.id)?.status === r.status && byId.get(r.id)?.transcript.length === r.transcript.length }))
  })()`)
  check('停止后渲染端子代理状态与主进程一致', final.length >= count && final.every((r) => r.same && r.status !== 'running'), final.filter((r) => !r.same).slice(0, 5))
  await ev(`window.__yanStore.getState().abort()`)
  await ev('window.__pa.stop = true')
}
