/**
 * 左栏常驻搜索：过滤正确、清空后焦点不丢。
 *
 * 对应方案 P1 4.1 的验收：
 *   · 清空搜索后恢复搜索前的展开状态（实现上搜索是「临时展开」，
 *     不改 collapsed/expanded 这两个 state，所以清空后自然恢复）
 *   · 焦点不丢（清空后留在输入框；Esc 清空，再按一次离开）
 *   · 搜索命中能定位、状态图标有文字提示
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
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  try {
    /* 左栏展开（默认收起） */
    store.getState().setRailPinned(true)
    await sleep(500)

    out.push('=== 1. 常驻搜索 ===')
    const input = q('[data-testid="rail-search"]')
    ok(!!input, '搜索框常驻')
    const inputBox = input?.getBoundingClientRect()
    input?.focus()
    ok(document.activeElement === input, '搜索框可聚焦')

    out.push('')
    out.push('=== 2. 过滤 + 展开状态不被破坏 ===')
    const beforeCollapsed = JSON.stringify(store.getState().sidebarCollapsed ?? null)
    const allCount = qa('.rail .srow').length
    /* 拿一个真实会话名的一个字来搜，保证必有命中 */
    const firstName = qa('.rail .srow .srow-name')[0]?.textContent?.trim() ?? ''
    const needle = firstName.slice(0, 1) || 'a'
    setVal(input, needle)
    await sleep(400)
    const hitCount = qa('.rail .srow').length
    out.push(`  搜索 ${JSON.stringify(needle)}：${allCount} → ${hitCount} 行`)
    ok(hitCount > 0, '有命中结果')
    ok(qa('.rail .srow .srow-name').some((x) => (x.textContent ?? '').includes(needle)), '命中的行确实包含关键字')

    out.push('')
    out.push('=== 3. 清空按钮：清空 + 焦点回输入框 ===')
    const clear = q('[data-testid="rail-search-clear"]')
    ok(!!clear, '有清空按钮')
    click(clear)
    await sleep(300)
    const input2 = q('[data-testid="rail-search"]')
    out.push('  清空后 value = ' + JSON.stringify(input2?.value))
    ok(input2 && input2.value === '', '内容已清空')
    ok(document.activeElement === input2, '焦点回到搜索框（可以接着搜）')
    ok(qa('.rail .srow').length === allCount, `列表恢复到全部（${allCount} 行）`)
    ok(
      JSON.stringify(store.getState().sidebarCollapsed ?? null) === beforeCollapsed,
      '展开状态没有被搜索改写过（清空后自然恢复）'
    )

    out.push('')
    out.push('=== 4. Esc 清空并退出输入框 ===')
    setVal(q('[data-testid="rail-search"]'), 'x')
    await sleep(200)
    const input3 = q('[data-testid="rail-search"]')
    if (input3) {
      input3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    }
    await sleep(300)
    ok(input3?.value === '', '首次 Esc 清空查询')
    input3?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(100)
    ok(document.activeElement !== input3, '再次 Esc 离开输入框')
    const inputBox2 = q('[data-testid="rail-search"]')?.getBoundingClientRect()
    ok(!!inputBox && !!inputBox2 && Math.abs(inputBox.x - inputBox2.x) < 1, '搜索框始终占据原位置')

    out.push('')
    out.push('=== 5. 会话状态图标带文字提示 ===')
    const statuses = qa('.session-status')
    const withTitle = statuses.filter((x) => (x.getAttribute('title') ?? '').trim().length > 0)
    out.push(`  状态图标 ${statuses.length} 个，其中带 title 的 ${withTitle.length} 个`)
    ok(statuses.length === 0 || withTitle.length === statuses.length, '每个状态图标都有文字提示')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
