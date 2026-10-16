;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  let original, savedDetail

  try {
    savedDetail = store.getState().settings?.responseDetail
    original = { session: store.getState().session, runners: store.getState().runners, activeRunnerId: store.getState().activeRunnerId }
    store.setState({ runners: [], activeRunnerId: null, session: { ...original.session, isStreaming: false, isCompacting: false } })
    for (let i = 0; i < 60; i++) {
      if (q('[data-testid="model-picker"]') && store?.getState().settings) break
      await sleep(250)
    }
    await sleep(600)

  out.push(`  model-picker 存在 = ${!!q('[data-testid="model-picker"]')}`)

    const before = store.getState().settings?.responseDetail
    out.push(`  初始 responseDetail = ${JSON.stringify(before)}`)
    ok(before === 'standard', '默认是 standard（与改动前行为一致）')

    q('[data-testid="model-picker"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(400)
    const stops = qa('[data-testid^="detail-"]')
    const buttons = qa('[data-testid="detail-stops"] button[aria-pressed]')
    out.push(`  档位按钮 = ${buttons.map((b) => b.textContent).join(' / ')}`)
    ok(buttons.length === 3, '菜单里有三档（简洁 / 标准 / 详细）')
    ok(!!q('[data-testid="detail-stops"] button[aria-pressed="true"]'), '分段里标出当前档位')
    ok(
      q('[data-testid="detail-standard"]')?.getAttribute('aria-pressed') === 'true',
      '当前档位是 standard'
    )
    ok(stops.length >= 3, '三档都有 data-testid（可被测试/辅助技术定位）')

    q('[data-testid="detail-detailed"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(500)
    const after = store.getState().settings?.responseDetail
    out.push(`  点击「详细」后 = ${JSON.stringify(after)}`)
    ok(after === 'detailed', '点击后设置变成 detailed')
    ok(
      q('[data-testid="detail-detailed"]')?.getAttribute('aria-pressed') === 'true',
      '选中态跟着更新'
    )

    q('[data-testid="detail-standard"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(400)
    ok(
      store.getState().settings?.responseDetail === 'standard',
      '能改回 standard（探针收尾不污染环境）'
    )
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error?.message ?? String(error)))
  } finally {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    if (savedDetail && store.getState().settings?.responseDetail !== savedDetail) {
      try { await store.getState().patchSettings({ responseDetail: savedDetail }) }
      catch (error) { out.push('  ✗ 设置复位失败: ' + String(error)) }
    }
    if (original) store.setState(original)
  }

  return out.join('\n')
})()
