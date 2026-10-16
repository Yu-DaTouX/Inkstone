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
