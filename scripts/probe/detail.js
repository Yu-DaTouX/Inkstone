/**
 * 回复详细程度：模型菜单里的三档 + 落盘（方案 3.1）。
 *
 * 为什么不测「模型真的更简洁了」：那要花 token 且不稳定。
 * 这里钉住的是**界面与设置**这条链路；提示注入由 test-unit
 * 的 test-response-detail 用假 pi API 覆盖。
 */
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

  try {
    for (let i = 0; i < 60; i++) {
      if (q('[data-testid="model-picker"]') && store?.getState().settings) break
      await sleep(250)
    }
    await sleep(600)

  /*
   * 隔离环境里 pi 可能没就绪（conn=exited）→ session.model 为空，
   * 而模型菜单在没有模型时**整个不渲染**（Pickers 里 `if (!cur) return null`）。
   * 往 store 里注入一个模型，让菜单能出来 —— 这是探针的常规手法。
   */
  if (!store.getState().session?.model) {
    const s = store.getState().session ?? {}
    store.setState({
      session: {
        ...s,
        model: { id: 'probe-model', name: 'Probe Model', provider: 'probe', reasoning: true }
      }
    })
    await sleep(300)
  }
  out.push(`  model-picker 存在 = ${!!q('[data-testid="model-picker"]')}`)

    const before = store.getState().settings?.responseDetail
    out.push(`  初始 responseDetail = ${JSON.stringify(before)}`)
    ok(before === 'standard', '默认是 standard（与改动前行为一致）')

    q('[data-testid="model-picker"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(400)
    const stops = qa('[data-testid^="detail-"]')
    const buttons = qa('[data-testid="detail-stops"] .mt-stop')
    out.push(`  档位按钮 = ${buttons.map((b) => b.textContent).join(' / ')}`)
    ok(buttons.length === 3, '菜单里有三档（简洁 / 标准 / 详细）')
    ok(!!q('[data-testid="detail-current"]'), '标题区显示当前档位')
    ok(
      q('[data-testid="detail-standard"]')?.dataset.on === '1',
      '当前档位是 standard'
    )
    ok(stops.length >= 3, '三档都有 data-testid（可被测试/辅助技术定位）')

    q('[data-testid="detail-detailed"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(500)
    const after = store.getState().settings?.responseDetail
    out.push(`  点击「详细」后 = ${JSON.stringify(after)}`)
    ok(after === 'detailed', '点击后设置变成 detailed')
    ok(
      q('[data-testid="detail-detailed"]')?.dataset.on === '1',
      '选中态跟着更新'
    )

    /* 还原：别把探针改的设置留给后面的场景 */
    q('[data-testid="detail-standard"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(400)
    ok(
      store.getState().settings?.responseDetail === 'standard',
      '能改回 standard（探针收尾不污染环境）'
    )
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
