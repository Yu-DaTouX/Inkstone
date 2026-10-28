export const meta = { description: '在最大的样本会话里流式输出长文本：测前台增量在长历史下的长任务与掉帧', samples: 1 }

export default async function run({ cdp, state, waitFor, check, report, turn, box }) {
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
  const history = await state('s.messages.length')
  await ev(`(() => {
    window.__lt = { entries: [], frames: { n: 0, over50: 0, max: 0 }, on: true }
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (window.__lt.on) window.__lt.entries.push(e.duration) }).observe({ type: 'longtask' })
    let last = performance.now()
    const tick = (now) => { const f = window.__lt.frames; const gap = now - last; if (window.__lt.on) { f.n++; if (gap > 50) f.over50++; if (gap > f.max) f.max = Math.round(gap) } last = now; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })()`)
  const started = Date.now()
  await turn('请输出 LONGTEXT', { timeout: 180000, settleMs: 0 })
  await ev('window.__lt.on = false')
  const lt = await ev('({ count: window.__lt.entries.length, total: Math.round(window.__lt.entries.reduce((a, b) => a + b, 0)), max: Math.round(Math.max(0, ...window.__lt.entries)), frames: window.__lt.frames })')
  report.timings.bigStream = { history, ms: Date.now() - started, ...lt }
  check('长文本完整', (await state(`s.messages.filter((x) => x.role === 'assistant').at(-1)?.text ?? ''`)).includes('结束。'))
  check(`长历史（${history} 条）下流式无超过 200ms 的卡顿`, lt.frames.max < 200, lt)
}
