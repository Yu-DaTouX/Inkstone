export const meta = { description: '待回答提问时重载渲染端：重载前后问答卡、侧栏等待状态与主进程待回答请求是否一致，重载后能否作答，不调用真实模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('STORM-Q STEPS2 ASK \\u8dd1\\u5b8c\\u95ee\\u6211')`)
  await waitFor(running, 20000, 20)
  await waitFor(`window.__yanRuns.getState().runs.some((r) => r.phase.kind === 'needs-you')`, 60000, 50)
  await sleep(1000)

  const view = () => ev(`(() => {
    const s = window.__yanStore.getState();
    return {
      cards: document.querySelectorAll('[data-testid="v3-question"]').length,
      uiRequests: s.uiRequests.length,
      runtimeRequests: Object.values(s.sessionRuntimes).reduce((n, rt) => n + (rt.uiRequests?.length ?? 0), 0),
      needsYou: window.__yanRuns.getState().runs.filter((r) => r.phase.kind === 'needs-you').length,
      sidebarWaiting: document.body.innerText.includes('\\u7b49\\u4f60\\u56de\\u7b54')
    };
  })()`)

  const before = await view()
  report.before = before
  log('before-reload', before)
  await shot('before-reload')
  check('\u91cd\u8f7d\u524d\u6709\u95ee\u7b54\u5361', before.cards > 0, before)

  await cdp.call('Page.reload')
  await sleep(500)
  await waitFor('!!window.__yanStore && !!document.querySelector(".ProseMirror")', 60000, 50)
  await sleep(3000)
  const after = await view()
  report.after = after
  log('after-reload', after)
  await shot('after-reload')
  check('\u91cd\u8f7d\u540e\u4fa7\u680f\u4ecd\u663e\u793a\u7b49\u4f60\u56de\u7b54', after.needsYou > 0 && after.sidebarWaiting, after)
  check('\u91cd\u8f7d\u540e\u95ee\u7b54\u5361\u6062\u590d', after.cards > 0, after)

  const answered = await ev(`(() => { const option = document.querySelector('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption'); if (!option) return false; option.click(); return true })()`)
  check('\u91cd\u8f7d\u540e\u80fd\u4f5c\u7b54', answered)
}
