;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (await predicate()) return true
      } catch {
      }
      await wait(100)
    }
    return false
  }
  const store = window.__yanStore
  const norm = (p) => (p ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

  try {
    out.push('=== 用正斜杠路径打开已有会话：保持原目录与项目（隔离探针）===')
    check(await until(() => !!store?.getState().settings, 8000), '设置已加载')
    await store.getState().refreshSessions()
    const currentCwd = store.getState().session?.cwd || store.getState().settings?.cwd
    const target = store.getState().sessions.find((s) => s.cwd && norm(s.cwd) !== norm(currentCwd) && s.path.includes('\\') && !s.archivedAt)
    if (!check(!!target, `找到一个与当前目录不同的已有会话（当前 ${currentCwd}）`)) return out.join('\n')
    note(`目标会话：${target.path}（cwd ${target.cwd}，projectId ${target.projectId ?? '无'}，scope ${target.scope ?? '无'}）`)
    const slashPath = target.path.replace(/\\/g, '/')
    const calls = []
    const realSelect = window.yan.selectSession
    let spied = false
    try {
      window.yan.selectSession = async (req) => { calls.push(req); return realSelect(req) }
      spied = window.yan.selectSession !== realSelect
    } catch {
    }
    await store.getState().switchSession(slashPath)
    await wait(1500)
    if (spied) {
      const req = calls[calls.length - 1]
      note(`selectSession 请求：${JSON.stringify(req)}`)
      check(norm(req?.cwd) === norm(target.cwd), '请求使用会话自己的目录，而不是当前目录')
      check((req?.projectId ?? null) === (target.projectId ?? null) || target.scope === 'global', '请求使用会话自己的项目')
      check(req?.sessionFile === target.path, '请求使用会话列表里的原始路径')
    } else {
      note('preload 对象不可写，改用结果核对')
    }
    const runner = store.getState().runners.find((r) => r.id === store.getState().activeRunnerId || r.runId === store.getState().activeRunnerId)
    const pending = store.getState().pendingActivation
    const usedCwd = pending?.cwd ?? runner?.cwd ?? store.getState().session?.cwd
    note(`打开后目录：${usedCwd}${pending ? '（只读打开，待激活）' : ''}`)
    check(norm(usedCwd) === norm(target.cwd), '打开后的运行目录是会话自己的目录')
    await store.getState().refreshSessions()
    const after = store.getState().sessions.find((s) => s.id === target.id)
    check((after?.projectId ?? null) === (target.projectId ?? null), `会话没有被改挂到别的项目（之后 ${after?.projectId ?? '无'}）`)
    out.push('证据范围：隔离数据目录、真实 switchSession → selectSession 主进程路径；只读打开，未发消息、未调模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
