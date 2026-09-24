/* H-6b 真强杀写侧：测试进程会在完整的 final:false 落盘后强制终止 Electron。 */
;(async () => {
  const out = []
  const ok = (condition, label) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + label)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const state = () => store.getState()
  const until = async (fn, timeoutMs = 30000, stepMs = 150) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await sleep(stepMs)
    }
    return null
  }
  const marker = 'YAN_H6B_REAL_HARD_KILL_PROBE_20260924'

  try {
    const ready = await until(() => state().conn === 'ready' && state().settings, 45000)
    ok(!!ready, '隔离 Electron 与 pi RPC 已就绪')
    if (!ready) return out.join('\n')
    localStorage.setItem('yan.onboarded', '1')

    const created = await state().newSession({ cwd: state().settings.cwd, scope: 'global' })
    ok(created?.ok === true, `新建专用隔离会话（${created?.sessionId ?? '无 sessionId 回执'}）`)
    if (created?.ok !== true) return out.join('\n')

    await state().setWorkMode('standard')
    await state().reloadModels?.()
    const model = await window.yan.setModel('yantimingfixture', 'turn-timing-isolation-fixture')
    ok(model?.ok === true, '选择本机 cost 0 fixture provider')
    if (model?.ok !== true) return out.join('\n')

    const sent = await window.yan.send(
      `${marker}\n请用 bash 恰好执行一次 echo H6B_TURN_TIMING_KILL_TOOL_RAN，然后等待后续输入。`
    )
    ok(sent?.ok === true, '测试用户消息已提交')
    if (sent?.ok !== true) return out.join('\n')

    const started = await until(() => state().session?.isAgentRunning, 30000)
    ok(!!started, '主进程 runner 已开始处理测试消息')
    if (!started) return out.join('\n')

    /* 父进程须等 provider 收到第二次请求且 final:false 已落盘，再强制结束应用。 */
    await sleep(80000)
    out.push('  ✗ 测试父进程未在预期窗口内强制结束隔离 Electron')
  } catch (error) {
    out.push('  探针出错：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
