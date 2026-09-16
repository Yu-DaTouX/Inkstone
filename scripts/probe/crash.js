/**
 * 渲染异常兜底（D8）。
 *
 * 要验的是一条**最坏情况**：界面在渲染期抛错时，用户看到的是不是一个
 * 说得清、能自救的界面，而不是整屏白。
 *
 * 触发方式：把 `sessions` 置成非法值（`null`）。Rail 会立刻在 `.map` 上抛错，
 * 于是整棵树被 React 卸载 —— 这正是当年白屏的现场。
 *
 * ⚠️ 这个探针会**故意毁掉当前界面**（boundary 一旦接管就不会自动恢复），
 * 所以它必须独立成一个场景，不能塞进别的探针末尾。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  try {
    for (let i = 0; i < 60; i++) {
      if (store?.getState().settings) break
      await sleep(250)
    }
    out.push('=== 前置 ===')
    ok(!!q('.app'), '正常界面已经渲染出来')
    ok(!q('[data-testid="crash-screen"]'), '兜底界面平时不出现')

    out.push('')
    out.push('=== 制造一次渲染期异常 ===')
    /* 非法数据形状 → Rail 渲染时抛错 → ErrorBoundary 接管 */
    store.setState({ sessions: null })
    await sleep(1800)

    const screen = q('[data-testid="crash-screen"]')
    ok(!!screen, '出现兜底界面（不是整屏白）')
    ok(!q('.rail') || !!screen, '原界面已让位给兜底界面')
    ok(!!q('[data-testid="crash-reload"]'), '有「重新加载界面」出口')
    ok(!!q('[data-testid="crash-copy"]'), '有「复制详情」')
    const detail = q('[data-testid="crash-detail"]')?.textContent ?? ''
    out.push(`  详情长度 = ${detail.length}`)
    ok(detail.length > 0, '详情里有真实的错误信息')
    const text = document.body.textContent ?? ''
    ok(text.includes('界面出错了'), '文案是应用自己的（不是 React 默认错误页）')
    ok(!/Consider adding an error boundary/i.test(text), '没有把 React 的英文提示直接甩给用户')

    /*
     * 重新加载出口。
     *
     * ⚠️ 不能在这里 `await` 点击后的结果：点下去界面会 **reload**，
     * 而探针本身就跑在这个页面里 —— reload 会把这次执行连根拔掉，
     * 于是 index.ts 永远等不到返回值，表现为“没抓到 PROBE 输出”。
     * 所以只排一个延时点击（让结果先返回），再单独断言按钮真的可点。
     */
    out.push('')
    out.push('=== 重新加载出口 ===')
    const reloadBtn = q('[data-testid="crash-reload"]')
    ok(!reloadBtn?.disabled, '「重新加载界面」按钮可点（不是禁用占位）')
    ok(!!reloadBtn?.onclick || typeof reloadBtn?.click === 'function', '按钮挂了真实点击处理')
    setTimeout(() => reloadBtn?.click(), 1500)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
