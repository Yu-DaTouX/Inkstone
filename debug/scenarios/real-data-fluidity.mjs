import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PROBES, RENDER_HOOK, RENDER_START, RENDER_TAKE, SUMMARY, useRealWindow } from '../lib/perf-probes.mjs'
import { memoryByKind, sampleProcessTree } from '../lib/process-tree.mjs'

export const meta = { description: '真实数据副本（配 --user-data）：重载、输入、切大会话、连续切换、会话栏与右栏、用量与设置页、反复切换后的内存，全程测主进程 IPC 往返；YAN_LONG_SCROLL_SOURCE 可加一个超大会话，不调用模型', samples: 2 }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const extra = process.env.YAN_LONG_SCROLL_SOURCE
  let huge = null
  if (extra) {
    const dir = join(box.sessionsDir, '--long-scroll-fixture--')
    mkdirSync(dir, { recursive: true })
    huge = join(dir, basename(extra))
    copyFileSync(extra, huge)
  }

  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: RENDER_HOOK })
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  const heap = async () => {
    await cdp.call('HeapProfiler.collectGarbage').catch(() => {})
    await sleep(300)
    const m = await metrics()
    return { jsHeapMB: Math.round(m.JSHeapUsedSize / 1048576), domNodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents }
  }

  const reloadStart = Date.now()
  await cdp.call('Page.reload')
  await sleep(300)
  await waitFor('!!window.__yanStore && !!window.yan', 60000, 20)
  const storeReadyMs = Date.now() - reloadStart
  await ev(PROBES)
  await waitFor('s.sessions.length > 0', 60000, 20)
  const sessionsMs = Date.now() - reloadStart
  await waitFor('!!document.querySelector(".ProseMirror")', 60000, 20)
  const composerMs = Date.now() - reloadStart
  await ev('window.__yanStore.getState().refreshSessions()')
  await sleep(2500)
  const paint = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; const p = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)])); return { domContentLoaded: Math.round(n?.domContentLoadedEventEnd ?? 0), load: Math.round(n?.loadEventEnd ?? 0), ...p } })()`)
  const sessionCount = await ev('window.__yanStore.getState().sessions.length')
  report.timings.reload = { storeReadyMs, sessionsMs, composerMs, paint, sessionCount, ...(await ev(SUMMARY('boot'))) }
  log('reload', report.timings.reload)
  check('真实数据副本已载入会话列表', sessionCount >= 10, { sessionCount })

  const phase = async (name, action, settle = 800) => {
    const before = await metrics()
    await ev(`window.__pa.phase = ${JSON.stringify(name)}`)
    await ev(RENDER_START)
    const t = Date.now()
    const out = (await action()) ?? {}
    const ms = Date.now() - t
    await sleep(settle)
    const after = await metrics()
    const { renders, regions, causes } = await ev(RENDER_TAKE)
    await ev(`window.__pa.phase = 'between'`)
    const cpu = {}
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) cpu[key] = Math.round((after[key] - before[key]) * 1000)
    const result = { ms, ...out, ...(await ev(SUMMARY(name))), cpu, renders, regions, causes }
    report.timings[name] = result
    log(name, result)
    return result
  }

  const switchTo = async (path) => {
    const t = Date.now()
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(path)})`)
    await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(path)} && s.messages.length > 0`, 90000, 10)
    return Date.now() - t
  }

  const typing = async () => {
    await ev(`document.querySelector('.ProseMirror').focus()`)
    for (let i = 0; i < 40; i++) {
      await cdp.call('Input.insertText', { text: '流畅输入' })
      await sleep(20)
    }
    const kept = await ev(`document.querySelector('.ProseMirror').textContent.includes('流畅输入'.repeat(40))`)
    await ev(`window.__yanStore.setState({ editorInject: { text: '', mode: 'replace' } })`)
    return { kept }
  }

  await phase('idle', async () => { await sleep(3000) }, 0)
  const realSessions = (await ev(`window.__yanStore.getState().sessions.filter((x) => x.messageCount > 4 && !x.path.includes('--long-scroll-fixture--') && !${JSON.stringify(box.samples)}.includes(x.path)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map((x) => ({ path: x.path, cwd: x.cwd }))`)).filter((x) => existsSync(x.cwd)).slice(0, 6).map((x) => x.path)
  check('有可切换的真实会话', realSessions.length >= 3, { count: realSessions.length })
  if (realSessions[0]) await switchTo(realSessions[0])
  await sleep(1500)

  const typedSmall = await phase('typing-real-sidebar', typing)
  check('真实会话列表下输入完整', typedSmall.kept)

  const big = huge ?? box.samples[0]
  await phase('switch-big', async () => ({ switchMs: await switchTo(big), messages: await ev('window.__yanStore.getState().messages.length') }), 2000)
  await shot('big-session')
  const typedBig = await phase('typing-big-session', typing)
  check('大会话里输入完整', typedBig.kept)

  const targets = [...realSessions, ...box.samples].filter(Boolean)
  await phase('idle-switches', async () => {
    const times = []
    for (const target of targets) {
      times.push(await switchTo(target))
      await sleep(500)
    }
    return { switchMs: times }
  }, 500)

  if (big) await switchTo(big)
  await sleep(1500)
  await phase('rail-off', async () => { await ev(`window.__yanStore.getState().patchSettings({ workspaceTiles: false })`) }, 1200)
  await phase('rail-on', async () => { await ev(`window.__yanStore.getState().patchSettings({ workspaceTiles: true })`) }, 1200)
  await phase('right-panel-open', async () => { await ev(`window.__yanStore.getState().setRightPanelOpen(true)`) }, 1200)
  await shot('right-panel')
  await phase('right-panel-close', async () => { await ev(`window.__yanStore.getState().setRightPanelOpen(false)`) }, 1200)

  await phase('usage-open', async () => {
    const t = Date.now()
    await ev(`window.location.hash = '#/usage'`)
    await waitFor(`document.querySelector('[data-testid="usage-details"]')?.getAttribute('aria-busy') === 'false'`, 90000, 20)
    return { readyMs: Date.now() - t }
  }, 1500)
  await shot('usage')
  await phase('usage-back', async () => {
    await ev(`document.querySelector('[data-testid="v3-back"]')?.click()`)
    await waitFor(`!document.querySelector('[data-testid="usage-details"]')`, 30000, 20)
  }, 1200)

  await phase('settings-open', async () => {
    await ev(`window.__yanStore.getState().openSettings('appearance')`)
    await waitFor('s.settingsOpen', 10000, 20)
  }, 1500)
  await phase('settings-close', async () => {
    await ev(`window.__yanStore.getState().closeSettings()`)
  }, 1200)

  const marker = box.userData
  const memBefore = { renderer: await heap(), processes: memoryByKind(sampleProcessTree(marker)) }
  await phase('memory-switches', async () => {
    const times = []
    for (let round = 0; round < 3; round++) {
      for (const target of [big, ...targets]) {
        times.push(await switchTo(target))
        await sleep(200)
      }
    }
    return { switches: times.length, switchMsMax: Math.max(...times), switchMsMedian: times.sort((a, b) => a - b)[Math.floor(times.length / 2)] }
  }, 1500)
  await sleep(3000)
  const memAfter = { renderer: await heap(), processes: memoryByKind(sampleProcessTree(marker)) }
  report.timings.memory = { before: memBefore, after: memAfter }
  log('memory', report.timings.memory)
  check('记录到内存数据', !!memBefore.renderer.jsHeapMB && !!memAfter.renderer.jsHeapMB)
  await ev('window.__pa.stop = true')
}
