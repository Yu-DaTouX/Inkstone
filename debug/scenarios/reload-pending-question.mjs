export const meta = { description: '待回答提问时重载渲染端：当前会话与后台会话各有一个待回答提问，重载后问答卡恢复、侧栏等待状态一致、重放不再弹提醒，作答后会话跑完，不调用真实模型' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, autoApprove, newSession, running, state }) {
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await newSession(box.projects[1] ?? box.project)
  await ev(`window.__yanStore.getState().send('STORM-BG STEPS2 ASK \\u540e\\u53f0\\u4f1a\\u8bdd\\u95ee\\u6211')`)
  await waitFor(running, 20000, 20)
  const background = { sessionId: await state('s.session?.sessionId'), path: await state('s.session?.sessionFile') }
  await waitFor(`window.__yanRuns.getState().runs.filter((r) => r.phase.kind === 'needs-you').length >= 1`, 60000, 50)
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('STORM-Q STEPS2 ASK \\u8dd1\\u5b8c\\u95ee\\u6211')`)
  await waitFor(running, 20000, 20)
  await waitFor(`window.__yanRuns.getState().runs.filter((r) => r.phase.kind === 'needs-you').length >= 2`, 60000, 50)
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

  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__alerts = 0; const N = window.Notification; if (N) { window.Notification = function (...args) { window.__alerts++; return new N(...args) }; Object.assign(window.Notification, N) }' })
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
  check('\u540e\u53f0\u4f1a\u8bdd\u7684\u63d0\u95ee\u4e5f\u6062\u590d\u5230\u5b83\u7684\u7f13\u5b58', after.runtimeRequests >= 2, after)
  check('\u91cd\u653e\u4e0d\u5f39\u7cfb\u7edf\u901a\u77e5', (await ev('window.__alerts ?? 0')) === 0)

  const answered = await ev(`(() => { const option = document.querySelector('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption'); if (!option) return false; option.click(); return true })()`)
  check('\u91cd\u8f7d\u540e\u80fd\u4f5c\u7b54', answered)

  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(background.path)})`)
  await waitFor(`!s.switchLoading && s.session?.sessionId === ${JSON.stringify(background.sessionId)}`, 20000, 20)
  await sleep(1500)
  const switched = await view()
  report.switched = switched
  log('background-after-switch', switched)
  await shot('background-after-switch')
  check('\u5207\u5230\u540e\u53f0\u4f1a\u8bdd\u540e\u5b83\u7684\u95ee\u7b54\u5361\u5728', switched.cards > 0, switched)
  const answeredBackground = await ev(`(() => { const option = document.querySelector('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption'); if (!option) return false; option.click(); return true })()`)
  check('\u540e\u53f0\u4f1a\u8bdd\u7684\u63d0\u95ee\u4e5f\u80fd\u4f5c\u7b54', answeredBackground)
  await waitFor(`window.__yanRuns.getState().runs.every((r) => r.phase.kind !== 'running' && r.phase.kind !== 'needs-you')`, 120000, 200)
  check('\u4e24\u4e2a\u4f1a\u8bdd\u4f5c\u7b54\u540e\u90fd\u8dd1\u5b8c', true)
}
