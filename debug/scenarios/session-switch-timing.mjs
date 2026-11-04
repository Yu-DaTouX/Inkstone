export const meta = { description: '真实数据副本（配 --user-data）：在跨项目的大会话之间来回切换，分段记录读历史、首帧、拿到运行实例与整体耗时，不调用模型' }

const PICKS = (process.env.YAN_SWITCH_IDS ?? '01a1a0c0,01a199e2,01a1a42d,01a19f8f,01a19ecb').split(',').filter(Boolean)

export default async function run({ cdp, waitFor, check, report, sleep, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.sessions.length > 0', 60000, 20)
  await sleep(2000)
  const targets = await ev(`(() => {
    const sessions = window.__yanStore.getState().sessions
    return ${JSON.stringify(PICKS)}.map((id) => sessions.find((x) => x.path.includes(id))).filter(Boolean).map((x) => ({ path: x.path, cwd: x.cwd, title: x.title ?? x.name ?? '' }))
  })()`)
  check('找到要切换的真实会话', targets.length >= 3, { found: targets.length, wanted: PICKS.length })
  report.targets = targets

  const switchOnce = async (target) => {
    await ev(`performance.clearMarks(); window.__switchT0 = performance.now()`)
    const started = Date.now()
    const run = ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target.path)}).then(() => performance.now() - window.__switchT0)`)
    await waitFor(`s.messages.length > 0 && !s.switchLoading`, 90000, 10)
    const visibleMs = Date.now() - started
    const awaitedMs = Math.round(await run)
    await waitFor(`s.session?.sessionFile === ${JSON.stringify(target.path)} || !!s.pendingActivation`, 90000, 10).catch(() => {})
    const attachedMs = Date.now() - started
    const marks = await ev(`Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('yan:switch')).map((m) => [m.name.slice(11), Math.round(m.startTime - window.__switchT0)]))`)
    const state = await ev(`(() => { const s = window.__yanStore.getState(); return { messages: s.messages.length, deferred: !!s.pendingActivation, runners: s.runners?.length ?? null } })()`)
    return { title: target.title.slice(0, 20), cwd: target.cwd, visibleMs, awaitedMs, attachedMs, marks, ...state }
  }

  const rounds = []
  for (let round = 1; round <= 2; round++) {
    const rows = []
    for (const target of targets) {
      const row = await switchOnce(target)
      rows.push(row)
      log(`round${round}`, row)
      await sleep(800)
    }
    rounds.push(rows)
  }
  report.timings.rounds = rounds
  await shot('after-switches')
  const worst = Math.max(...rounds.flat().map((row) => row.awaitedMs))
  report.timings.worstAwaitedMs = worst
  check('切换都完成', rounds.flat().every((row) => row.messages > 0), { worst })
}
