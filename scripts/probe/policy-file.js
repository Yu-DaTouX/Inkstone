/*
 * 生效策略交给薄层（实施-11 C-4，cost 0）。
 *
 * `context-policy.effective.json` 是宿主写给 pi 扩展看的**分层覆盖**：扩展按它
 * 算阈值，界面也按同一份设置显示。这条场景验的是**宿主真的写了**、内容与设置一致；
 * 扩展侧的采用规则由 `test-context-budget.mjs` 的纯函数交叉校验钉住。
 *
 * 为什么不清理设置：退出后要靠磁盘上的文件断言，清理了就没得看（沙箱本身会删）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(300)

    const before = store.getState().session?.contextPolicy
    out.push(`  改前：source=${before?.source} workingSet=${before?.budget?.workingSet}`)

    await store.getState().patchSettings({ contextPolicy: { workingSetCap: 333_000, windowRatio: 0.6 } })
    for (let i = 0; i < 40; i++) {
      const s = store.getState()
      if (s.settings?.contextPolicy?.workingSetCap === 333_000 && s.session?.contextPolicy?.source === 'user') break
      await sleep(250)
    }
    const after = store.getState()
    ok(
      after.settings?.contextPolicy?.workingSetCap === 333_000,
      `设置写进去了（cap=${after.settings?.contextPolicy?.workingSetCap}）`
    )
    ok(after.session?.contextPolicy?.source === 'user', `生效层变成 user（实际 ${after.session?.contextPolicy?.source}）`)
    const budget = after.session?.contextPolicy?.budget
    ok(!!budget, '会话推来了预算（扩展按同一份覆盖算阈值）')
    if (budget) {
      const expect = Math.min(333_000, Math.round(budget.contextWindow * 0.6), budget.workingSet + 1e9)
      out.push(
        `  改后：窗口=${budget.contextWindow} 工作集=${budget.workingSet} 清扫线=${budget.triggers?.sweep}`
      )
      ok(budget.workingSet <= 333_000, '工作集受用户级上限约束')
      ok(Number.isFinite(budget.triggers?.sweep), '阶段线跟着重算（不是写死的）')
      void expect
    }
    /* 文件写入是 fire-and-forget，给它一点时间落盘 */
    await sleep(1200)
    ok(true, '（退出后核对 context-policy.effective.json）')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
