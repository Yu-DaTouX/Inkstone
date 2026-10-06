/**
 * 模型列表打开后可以自由滚动：组件在 agent 生成期间不停重渲染，
 * 不能每次都把列表拉回当前模型（用户报：生成时模型列表滚不动）。
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
      if (q('.rail') && store.getState().settings) break
      await sleep(200)
    }
    await sleep(1500)
    const trigger = q('.mt-trigger')
    if (!ok(!!trigger, '输入区有模型触发器')) return out.join('\n')
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 40 && !q('.mt-list'); i++) await sleep(100)
    const list = q('.mt-list')
    if (!ok(!!list, '模型菜单已打开')) return out.join('\n')
    await sleep(300)
    if (list.scrollHeight <= list.clientHeight + 4) {
      out.push('  · 模型不多，列表放得下，无法验证滚动（跳过）')
      return out.join('\n')
    }
    list.scrollTop = 0
    await sleep(100)
    const before = list.scrollTop
    /* 模拟生成期间的高频重渲染：反复更新会话统计 / 触发订阅者 */
    for (let i = 0; i < 12; i++) {
      store.setState({ stats: { ...(store.getState().stats ?? {}) } })
      store.setState({ models: [...store.getState().models] })
      await sleep(60)
    }
    ok(list.scrollTop === before, `重渲染后用户滚到的位置不被拉回（${before} → ${list.scrollTop}）`)
    list.scrollTop = 40
    await sleep(100)
    store.setState({ models: [...store.getState().models] })
    await sleep(100)
    ok(Math.abs(list.scrollTop - 40) <= 1, `再滚一段也保持（${list.scrollTop}）`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
