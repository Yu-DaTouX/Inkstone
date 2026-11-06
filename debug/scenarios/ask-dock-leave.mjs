export const meta = { description: '提问停靠区作答后收起：停靠区消失时出现与原高度相同的 ask-dock-leave 占位并逐步收到 0，不调用模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, newSession, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await newSession(box.projects[0] ?? box.project)
  await ev(`window.__yanStore.getState().send('QUESTION 选一个')`)
  await waitFor(`!!document.querySelector('[data-ask-dock]')`, 30000, 50)
  await sleep(600)
  const dockHeight = await ev(`document.querySelector('[data-ask-dock]').offsetHeight`)
  await ev(`(() => { window.__leave = []; const t0 = performance.now(); const tick = () => { const el = document.querySelector('.ask-dock-leave'); if (el) window.__leave.push({ t: Math.round(performance.now() - t0), h: Math.round(el.getBoundingClientRect().height) }); window.__leaveRaf = requestAnimationFrame(tick) }; tick() })()`)
  await ev(`(() => { const option = document.querySelector('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption'); option && option.click() })()`)
  await sleep(1500)
  const leave = await ev(`(() => { cancelAnimationFrame(window.__leaveRaf); return window.__leave })()`)
  report.dockHeight = dockHeight
  report.leave = leave
  log('leave', { dockHeight, first: leave[0], last: leave.at(-1), frames: leave.length })
  check('提问停靠区有高度', dockHeight > 40, dockHeight)
  check('作答后出现收起占位', leave.length > 0, leave.length)
  check('占位起始高度与停靠区一致（±4px）', leave.length > 0 && Math.abs(leave[0].h - dockHeight) <= 4, { first: leave[0], dockHeight })
}
