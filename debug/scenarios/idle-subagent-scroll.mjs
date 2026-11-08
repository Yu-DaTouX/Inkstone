export const meta = { description: '长会话主回合已结束、尾部子代理仍在运行（行高随最近动作变化，完成通知会触发新回合）时，反复往上滚几格再往下滚回底部：逐帧记录滚动位置，检查往下滚时有没有被往回拉', samples: 1 }

const RECORDER = `(() => {
  const rec = window.__scrollRec = { frames: [], on: true }
  const tick = (t) => {
    const el = document.querySelector('.v3-stream-host .v3-stream')
    const s = window.__yanStore.getState()
    if (rec.on && el) {
      const last = [...el.querySelectorAll('.v3-msg[data-turn-id]')].at(-1)
      rec.frames.push({
        t, top: Math.round(el.scrollTop), h: el.scrollHeight, c: el.clientHeight,
        tail: last ? Math.round(last.getBoundingClientRect().height) : 0,
        tailId: last?.dataset.turnId ?? null,
        running: !!(s.session?.isAgentRunning || s.session?.isStreaming),
        rows: [...el.querySelectorAll('.v3-stream-row')].slice(-3).map((row) => Math.round(row.getBoundingClientRect().height) + (row.style.minHeight ? '/' + row.style.minHeight : '')),
        inner: el.firstElementChild ? Math.round(el.firstElementChild.getBoundingClientRect().height) : 0,
        pad: getComputedStyle(el).paddingBottom,
        composer: Math.round(document.querySelector('.v3-composer, [data-testid="v3-composer"]')?.getBoundingClientRect().height ?? 0),
        sa: last ? (() => { const box = last.querySelector('[data-testid="v3-subagents"]'); const list = last.querySelector('[data-testid="v3-subagent-list"]'); return [box ? Math.round(box.getBoundingClientRect().height) : -1, list ? Math.round(list.getBoundingClientRect().height) : -1, last.querySelectorAll('[data-testid="v3-subagent-row"], [data-testid="v3-subagent-tile"]').length, list?.dataset.layout ?? '', box?.getAttribute('style') ?? ''].join('|') })() : '',
        kids: last ? [...(last.querySelector('.v3-turn-body, .v3-msg-body') ?? last).children].map((k) => (k.dataset.testid || (typeof k.className === 'string' ? k.className.split(' ')[0] : '')) + ':' + Math.round(k.getBoundingClientRect().height)).join(',') : '',
        lastTop: last ? Math.round(last.getBoundingClientRect().top - el.getBoundingClientRect().top) : null
      })
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

export default async function run({ cdp, waitFor, check, report, turn, box, sleep, shot, log, autoApprove }) {
  const [big] = box.samples
  if (!big) throw new Error('需要大会话样本：先跑 npm run debug -- samples pick')
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.sessions.length > 0', 30000)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(big)})`)
  await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(big)}`, 30000, 20)
  check('切到大会话后激活成功', (await ev('window.__yanStore.getState().ensureActivated()')) !== false)
  await waitFor('!s.pendingActivation && !s.peekedPath', 30000, 20)
  const model = await ev(`window.__yanStore.getState().setModel('fake', 'fake-model', true)`)
  check('切到假模型', model?.ok !== false, model)
  await autoApprove()
  log('虚拟列表', await ev(`!document.querySelector('.v3-stream-host .v3-stream-inner')`))

  await turn(process.env.YAN_SCROLL_PROMPT || 'SUBAGENTS3 THENREST 派三个子代理', { timeout: 120000 })
  await waitFor(`(s.subagents ?? []).filter((a) => a.status === 'running').length >= 1`, 60000)
  await ev(RECORDER)

  const center = await ev(`(() => { const r = document.querySelector('.v3-stream-host').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const wheel = (deltaY) => cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY })
  const subRunning = () => ev(`(window.__yanStore.getState().subagents ?? []).some((a) => a.status === 'running' || a.status === 'starting')`)

  const windows = []
  const deadline = Date.now() + Number(process.env.YAN_SCROLL_MS ?? 150000)
  while (Date.now() < deadline && await subRunning()) {
    for (let i = 0; i < 4; i++) { await wheel(-200); await sleep(50) }
    await sleep(500)
    const from = await ev('performance.now()')
    for (let i = 0; i < 14; i++) { await wheel(100); await sleep(90) }
    await sleep(1500)
    const to = await ev('performance.now()')
    windows.push({ from, to })
    if (windows.length === 8) await shot('idle-subagent-scroll')
  }

  await ev('window.__scrollRec.on = false')
  const result = await ev(`(() => {
    const rec = window.__scrollRec
    return ${JSON.stringify(windows)}.map(({ from, to }) => {
      const frames = rec.frames.filter((f) => f.t >= from && f.t <= to)
      const back = []
      for (let i = 1; i < frames.length; i++) {
        const drop = frames[i - 1].top - frames[i].top
        if (drop > 24 && frames[i].h - frames[i].c - frames[i].top > 24) back.push({ t: Math.round(frames[i].t - from), drop, top: frames[i].top, h: frames[i].h, prevH: frames[i - 1].h, tail: frames[i].tail, prevTail: frames[i - 1].tail, tailId: frames[i].tailId, prevTailId: frames[i - 1].tailId, running: frames[i].running, prevRunning: frames[i - 1].running, ctx: frames.slice(Math.max(0, i - 3), i + 3).map(({ t, top, h, rows, inner, pad, composer, lastTop, tail, sa, kids }) => ({ t: Math.round(t - from), top, h, rows, lastTop, tail, sa, kids })) })
      }
      const last = frames.at(-1)
      return { back, endGap: last ? last.h - last.c - last.top : null }
    })
  })()`)
  const pulled = result.flatMap((item, index) => item.back.map((b) => ({ cycle: index, ...b })))
  report.cycles = result
  check(`主回合结束、子代理运行中往下滚 ${result.length} 次都没有被往回拉`, result.length > 0 && pulled.length === 0, pulled.slice(0, 12))
  log('滚动结束时离底超过 40px 的轮次', result.map((item, index) => ({ cycle: index, gap: item.endGap })).filter((item) => item.gap === null || item.gap > 40).slice(0, 12))
}
