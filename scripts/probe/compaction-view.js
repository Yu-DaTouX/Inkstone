;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  const rowText = () => {
    const el = document.querySelector('[data-testid="ctx-last-compaction-reclaim"]')
    return el ? (el.textContent ?? '').trim() : null
  }
  const lineText = () => {
    const el = document.querySelector('[data-testid="ctx-last-compaction-tokens"]')
    return el ? (el.textContent ?? '').trim() : null
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const beforeSwitch = store.getState()
    if (!beforeSwitch.settings?.rightPanelOpen) {
      await beforeSwitch.setRightPanelOpen?.(true)
      await sleep(700)
    }
    const toolsTab = document.querySelector('[data-testid="right-window-tab-start"]')
    if (toolsTab) {
      toolsTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(700)
    }

    for (let i = 0; i < 20; i++) {
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]')
      if (toggle) {
        if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
        await sleep(400)
        break
      }
      await sleep(300)
    }

    const base = { status: 'completed', reason: 'threshold', startedAt: Date.now() - 60000, endedAt: Date.now() - 59000 }
    store.setState({
      session: {
        ...store.getState().session,
        isCompacting: false,
        compaction: undefined,
        lastCompaction: { ...base, beforeTokens: 36230, afterTokens: 18400 }
      },
      stats: { ...store.getState().stats, contextUsage: { tokens: 30000, contextWindow: 400000, percent: 7.5 } }
    })
    await sleep(700)
    ok(!!lineText(), `压缩前后用量那一行在（「${lineText()}」）`)
    const withBoth = rowText()
    ok(!!withBoth, `回收那一行在（「${withBoth}」）`)
    ok(/49/.test(withBoth ?? ''), '回收比例算出 49%（36230 → 18400）')
    ok(/(回收|reclaimed)/.test(withBoth ?? ''), '文案说的是「回收」而不是「压缩」')
    ok(/(此后新增|added since)/.test(withBoth ?? ''), '同一行给出「此后新增」（当前 30000 − 压缩后 18400）')
    ok(
      /(此后新增|added since)\s*1[12]/.test(withBoth ?? ''),
      '新增量按 formatTokens 给量级（11600 → 12k）'
    )

    store.setState({
      session: {
        ...store.getState().session,
        lastCompaction: { ...base, beforeTokens: 36230 }
      }
    })
    await sleep(500)
    const pending = rowText()
    ok(/(待测|pending)/i.test(pending ?? ''), `缺压缩后用量时写「待测」（「${pending}」）`)
    ok(!/\d+%/.test(pending ?? ''), '「待测」里没有假百分比')

    store.setState({
      session: {
        ...store.getState().session,
        lastCompaction: { ...base, beforeTokens: 36230, afterTokens: 18400 }
      },
      stats: { ...store.getState().stats, contextUsage: { tokens: null, contextWindow: 400000, percent: null } }
    })
    await sleep(500)
    const onlyReclaim = rowText()
    ok(/49/.test(onlyReclaim ?? ''), '当前用量未知时回收比例照给')
    ok(!/(此后新增|added since)/.test(onlyReclaim ?? ''), '当前用量未知时不显示「此后新增」（不能写成 0）')

    store.setState({
      session: {
        ...store.getState().session,
        lastCompaction: { ...base, status: 'failed', beforeTokens: 36230, afterTokens: 18400, error: 'boom' }
      }
    })
    await sleep(500)
    ok(rowText() === null, '失败的那次不显示回收行（失败有自己的说明）')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
