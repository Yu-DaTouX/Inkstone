import { useRealWindow } from '../lib/perf-probes.mjs'
export const meta = { description: '分屏运行中切换焦点后的实时更新与提问卡：两个会话同时跑 STORM，A 跑完发起提问；运行中反复点击切换分屏焦点，再关闭分屏，核对界面消息与主进程一致、等待回答时问答卡出现且能作答，不调用真实模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()

  const start = async (project, text) => {
    await newSession(project)
    const sent = await ev(`window.__yanStore.getState().send(${JSON.stringify(text)})`)
    if (sent === false) throw new Error('\u53d1\u9001\u5931\u8d25\uff1a' + text)
    await waitFor(`${running} && !!s.session?.sessionFile && !!s.session?.sessionId`, 30000, 20)
    return { sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') }
  }
  const slow = process.env.YAN_SPLIT_LIVE_SLOW === '1'
  report.variant = { slow }
  const A = await start(box.projects[0] ?? box.project, slow ? 'STORM-A STEPS9 SLOW ASK \u8dd1\u5b8c\u95ee\u6211' : 'STORM-A STEPS45 ASK \u8dd1\u5b8c\u95ee\u6211')
  const B = await start(box.projects[1] ?? box.project, slow ? 'STORM-B STEPS14 SLOW \u4e00\u76f4\u8dd1' : 'STORM-B STEPS70 \u4e00\u76f4\u8dd1')
  log('sessions', { A, B })
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify([A, B])}, live: 1 })`)
  await sleep(1500)

  const clickTitle = async (ref) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-pane="${ref.sessionId}"] .v3-split-title'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    if (!point) return false
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }

  const snapshot = () => ev(`(async () => {
    const s = window.__yanStore.getState();
    const main = await window.yan.getMessages().catch(() => []);
    const ids = new Set(s.messages.map((m) => m.id));
    const runs = window.__yanRuns.getState().runs.map((r) => ({ sid: r.sessionId, phase: r.phase.kind, request: r.phase.request?.id?.slice(-6) }));
    const mainPending = (await window.yan.pendingUiRequests().catch(() => [])).map((p) => ({ id: String(p.payload?.id ?? '').slice(-6), key: p.sessionKey ?? null }));
    return {
      view: s.session?.sessionId ?? null,
      active: s.activeRunnerId,
      peeked: s.peekedSessionId,
      peekPath: !!s.peekedPath,
      pending: !!s.pendingActivation,
      switchLoading: s.switchLoading,
      viewCount: s.messages.length,
      viewLast: s.messages.at(-1)?.id ?? null,
      mainCount: main.length,
      mainLast: main.at(-1)?.id ?? null,
      missingFromView: main.filter((m) => !ids.has(m.id)).length,
      uiRequests: s.uiRequests.map((r) => r.method + ':' + (r.title ?? r.message ?? '').slice(0, 20)),
      runtimeRequests: Object.fromEntries(Object.entries(s.sessionRuntimes).map(([id, rt]) => [id.slice(-6), rt.uiRequests?.length ?? 0])),
      runners: s.runners.map((r) => ({ sid: (r.sessionId ?? '').slice(-6), gen: r.generation, running: r.running, waiting: r.waiting, active: r.isActive })),
      runs,
      mainPending,
      split: window.__yanSplit.getState().split?.tiles.length ?? 0,
      cards: document.querySelectorAll('[data-testid="v3-question"]').length
    };
  })()`)

  const switches = []
  const drift = []
  for (let i = 0; i < (slow ? 14 : 10); i++) {
    const target = i % 2 === 0 ? A : B
    const t = Date.now()
    const clicked = await clickTitle(target)
    if (clicked) {
      try {
        await waitFor(`document.querySelector('[data-pane="${target.sessionId}"]')?.dataset.live === '1' && !s.switchLoading`, 15000, 10)
      } catch (error) {
        log('switch-timeout', String(error).slice(0, 300))
      }
    }
    switches.push(Date.now() - t)
    await sleep(slow ? 1200 + ((i * 677) % 1900) : 2500)
    const now = await snapshot()
    drift.push({ i, view: (now.view ?? '').slice(-6), missing: now.missingFromView, viewLast: now.viewLast, mainLast: now.mainLast, peeked: !!now.peeked, cards: now.cards })
  }
  report.drift = drift
  log('drift', drift)
  check('\u8fd0\u884c\u4e2d\u6bcf\u6b21\u5207\u6362\u540e\u754c\u9762\u90fd\u8ddf\u4e0a\u4e3b\u8fdb\u7a0b\uff08\u6700\u591a\u5dee 1 \u6761\u6d41\u5f0f\u4e2d\u7684\u6d88\u606f\uff09', drift.every((d) => d.missing <= 1), drift.filter((d) => d.missing > 1))
  report.timings.switchMs = switches
  log('switches', switches)
  await shot('after-switching')

  const askedAt = Date.now()
  await waitFor(`window.__yanRuns.getState().runs.some((r) => r.sessionId === ${JSON.stringify(A.sessionId)} && r.phase.kind === 'needs-you' && String(r.phase.request?.id ?? '').startsWith('yan-question-'))`, 180000, 100)
  report.timings.askWaitMs = Date.now() - askedAt
  await sleep(1500)
  const atAsk = await snapshot()
  report.atAsk = atAsk
  log('at-ask', atAsk)
  await shot('at-ask')

  await clickTitle(A)
  await sleep(2000)
  const focusedA = await snapshot()
  report.focusedA = focusedA
  log('focused-A', focusedA)
  await shot('focused-A')
  check('A \u7b49\u5f85\u56de\u7b54\u65f6\uff0c\u805a\u7126 A \u80fd\u770b\u5230\u95ee\u7b54\u5361', focusedA.cards > 0, focusedA)
  check('\u805a\u7126 A \u540e\u754c\u9762\u6d88\u606f\u4e0e\u4e3b\u8fdb\u7a0b\u4e00\u81f4', focusedA.view === A.sessionId && focusedA.missingFromView === 0, focusedA)

  await ev('window.__yanSplit.getState().close()')
  await sleep(1500)
  if ((await state('s.session?.sessionId')) !== A.sessionId) {
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(A.path)})`)
    await sleep(2000)
  }
  const single = await snapshot()
  report.single = single
  log('single-A', single)
  await shot('single-A')
  check('\u5173\u95ed\u5206\u5c4f\u540e A \u4ecd\u663e\u793a\u95ee\u7b54\u5361', single.cards > 0, single)
  check('\u5173\u95ed\u5206\u5c4f\u540e A \u754c\u9762\u6d88\u606f\u4e0e\u4e3b\u8fdb\u7a0b\u4e00\u81f4', single.missingFromView === 0, single)

  const answered = await ev(`(() => { const option = document.querySelector('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption'); if (!option) return false; option.click(); return true })()`)
  check('\u80fd\u70b9\u51fb\u95ee\u7b54\u5361\u9009\u9879', answered)
  if (answered) {
    await sleep(800)
    await ev(`(() => { const submit = [...document.querySelectorAll('[data-testid="v3-question"] button')].find((b) => /\u63d0\u4ea4|\u53d1\u9001|\u786e\u5b9a|Submit/.test(b.textContent ?? '')); submit?.click() })()`)
  }
  try {
    await waitFor(`window.__yanRuns.getState().runs.every((r) => r.phase.kind !== 'running' && r.phase.kind !== 'needs-you')`, 240000, 200)
  } catch (error) {
    log('finish-timeout', String(error).slice(0, 300))
  }
  await sleep(1500)
  const end = await snapshot()
  report.end = end
  log('end', end)
  check('\u4f5c\u7b54\u540e A \u8dd1\u5b8c\u5e76\u5728\u754c\u9762\u663e\u793a\u6700\u7ec8\u7b54\u6848', await ev(`document.body.innerText.includes('\u7ed3\u675f\u3002')`), end)
  check('\u7ed3\u675f\u65f6\u754c\u9762\u6d88\u606f\u4e0e\u4e3b\u8fdb\u7a0b\u4e00\u81f4', end.missingFromView === 0, end)
}
