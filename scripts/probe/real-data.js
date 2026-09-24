/**
 * 真实数据重启复核（只读）——用**用户真实数据的一份副本**启动隔离实例，
 * 看会话列表 / 目标 / 工作模式能不能被正确读出来。
 *
 * 副本路径由外部环境变量给出（`YAN_PI_DIR` 等），探针本身不碰任何目录；
 * 它只回答「界面里到底加载到了什么」。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore（探针没被注入）'
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 80; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  ok(S().conn === 'ready', `pi 已就绪（conn=${S().conn}）`)
  try {
    await S().refreshSessions?.()
  } catch {
    /* 读不到就保持原状，下面按现状报告 */
  }
  await sleep(2000)

  const sessions = S().sessions ?? []
  log(`  会话数 = ${sessions.length}`)
  log(
    '  样例（前 5）：' +
      JSON.stringify(
        sessions.slice(0, 5).map((s) => ({
          id: String(s.id ?? '').slice(0, 8),
          title: String(s.title ?? '').slice(0, 22),
          cwd: String(s.cwd ?? '').slice(-28),
          messages: s.messageCount ?? s.messages ?? null
        }))
      )
  )
  ok(sessions.length > 0, `真实会话列表可读（${sessions.length} 条）`)

  /* 打开一条有正文的真实历史会话：验证 Pi 0.87 下老会话文件仍能读出消息。 */
  const candidate = sessions.find((s) => Number(s.messageCount ?? 0) >= 5 && s.path)
  if (candidate) {
    log(`  打开历史会话：${String(candidate.title ?? '').slice(0, 20)}（摘要说 ${candidate.messageCount} 条）`)
    try {
      await S().switchSession(String(candidate.path))
    } catch (e) {
      log(`  switchSession 抛错：${e?.message ?? e}`)
    }
    for (let i = 0; i < 60; i++) {
      if ((S().messages ?? []).length > 0) break
      await sleep(500)
    }
    const loaded = S().messages ?? []
    log(
      `  加载后消息数 = ${loaded.length}｜首条 = ${loaded[0]?.role ?? ''}｜末条 = ${loaded.at(-1)?.role ?? ''}`
    )
    ok(loaded.length > 0, `真实历史会话正文可读（${loaded.length} 条消息）`)
    out.push(`  realdata.opened=${loaded.length}`)
  } else {
    log('  · 没找到带正文的历史会话样例')
  }

  const goal = S().goal
  /*
   * 真实目标持久化：打开**确实有目标记录**的真实会话，看宿主能不能按 sessionFile
   * 从副本 goals.json 把 phase / revision 读回来。
   */
  const GOAL_SAMPLE_IDS = [
    '01a0b84f-c768-73f1-b85c-3e70fe80ab18',
    '01a0b8af-39d6-7097-802a-78659a5258a2',
    '01a0c723-a5c6-77a2-b6da-eed22d5de909',
    '01a0c9e3-8566-77ad-9d33-4458555a7472'
  ]
  const goalProbe = []
  for (const want of GOAL_SAMPLE_IDS) {
    const s = sessions.find((x) => String(x.id ?? '').startsWith(want.slice(0, 13)))
    if (!s?.path) {
      goalProbe.push({ want: want.slice(0, 8), found: false })
      continue
    }
    try {
      await S().switchSession(String(s.path))
    } catch {
      /* 打开失败就记下来 */
    }
    await sleep(1500)
    goalProbe.push({
      id: want.slice(0, 8),
      goal: S().goal?.phase ?? null,
      rev: S().goal?.revision ?? null,
      msgs: (S().messages ?? []).length
    })
  }
  log('  有目标记录的真实会话：' + JSON.stringify(goalProbe))
  const recovered = goalProbe.filter((g) => g.goal && g.goal !== 'planning').length
  ok(recovered > 0, `打开后真实目标能恢复（${recovered}/${goalProbe.length} 非 planning）`)
  log(
    '  目标：' +
      JSON.stringify(goal ? { phase: goal.phase, revision: goal.revision, steps: (goal.steps ?? []).length } : null)
  )
  const workMode = S().workMode
  log('  工作模式：' + JSON.stringify(workMode ? { mode: workMode.mode ?? null, phase: workMode.phase ?? null } : null))
  log(
    '  当前会话 = ' +
      JSON.stringify(S().session?.sessionId ?? null) +
      '｜消息 = ' +
      String((S().messages ?? []).length)
  )
  log(`  左栏项目（rail）= ${JSON.stringify((S().projects ?? []).map((p) => String(p.name ?? p.id ?? '')).slice(0, 6))}`)

  out.push(`  realdata.sessions=${sessions.length}`)
  out.push(`  realdata.current=${S().session?.sessionId ?? ''}`)
  out.push(`  realdata.goal=${goal?.phase ?? ''}`)
  out.push(`  realdata.title0=${String(sessions[0]?.title ?? '').slice(0, 30)}`)
  return out.join('\n')
})()
