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
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)

  const openTool = async (tab) => {
    const direct = q(`wb-open-${tab}`)
    if (direct) {
      direct.click()
      await wait(200)
      return
    }
    q('wb-more-tools')?.click()
    const order = ['changes', 'preview', 'logs', 'branch', 'quota']
    const pick = () => document.querySelector(`.wb-more-menu [data-key="${tab}"]`) ?? document.querySelectorAll('.wb-more-menu [role="menuitem"]')[order.indexOf(tab)]
    for (let i = 0; i < 40 && !pick(); i++) await wait(50)
    pick()?.click()
    await wait(200)
  }
  const store = window.__yanStore
  const setNativeValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  try {
    out.push('=== v3 日志 / 额度页签（隔离探针）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }

    await openTool('quota')
    await openTool('logs')
    check(await until(() => !!q('wb-tab-logs') && !!q('wb-tab-quota'), 4000), '工作区有「日志」「额度」页签')

    out.push('')
    out.push('--- 1. 日志页 ---')
    const realLogs = store.getState().logs
    const realStatuses = store.getState().statuses
    store.setState({ logs: [], statuses: {} })
    q('wb-tab-logs')?.click()
    check(await until(() => !!q('v3-wb-logs-empty'), 3000), '没有日志和状态时给空状态')
    const lines = Array.from({ length: 260 }, (_, i) => (i % 10 === 0 ? `[warn] 第 ${i} 行 需要注意` : `[info] 第 ${i} 行 正常`))
    store.setState({ logs: lines, statuses: { 'probe-ext': '就绪' } })
    check(await until(() => !!q('v3-wb-logs-body'), 3000), '有日志后显示日志正文')
    check(q('v3-wb-logs-status')?.textContent?.includes('probe-ext') === true, '显示扩展状态行')
    const shown = q('v3-wb-logs-body').textContent.split('\n')
    check(shown.length === 200, `只显示最后 200 行（实际 ${shown.length}）`)
    check(shown[shown.length - 1].includes('第 259 行'), '末行是最新一行')
    check(q('v3-wb-logs-count')?.textContent?.trim() === '260', `计数显示总行数（实际 ${JSON.stringify(q('v3-wb-logs-count')?.textContent)}）`)

    setNativeValue(q('v3-wb-logs-filter'), '需要注意')
    await wait(200)
    const filtered = q('v3-wb-logs-body').textContent.split('\n')
    check(filtered.length > 0 && filtered.every((line) => line.includes('需要注意')), `过滤后只剩匹配行（${filtered.length} 行）`)
    const written = []
    const realWrite = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = async (value) => { written.push(value) }
    q('v3-wb-logs-copy')?.click()
    check(await until(() => written.length === 1, 2000), '触发复制')
    check(written[0] === filtered.join('\n'), '复制的是当前过滤后的可见行')
    navigator.clipboard.writeText = realWrite
    setNativeValue(q('v3-wb-logs-filter'), '不存在的关键字xyz')
    await wait(200)
    check(!q('v3-wb-logs-body'), '无匹配时不显示空正文')
    setNativeValue(q('v3-wb-logs-filter'), '')
    store.setState({ logs: realLogs, statuses: realStatuses })

    out.push('')
    out.push('--- 2. 额度页 ---')
    const descriptor = Object.getOwnPropertyDescriptor(window.yan, 'accountQuota')
    const overridable = !!descriptor && (descriptor.writable || descriptor.configurable)
    note(overridable ? 'window.yan.accountQuota 可覆盖，走注入数据' : 'window.yan 被冻结，改走真实只读查询')
    const realQuota = window.yan.accountQuota
    const now = Date.now()
    if (overridable) {
      window.yan.accountQuota = async () => ({
        checkedAt: now,
        prefs: { labels: {}, sources: {} },
        cards: [
          { key: 'a1', source: 'yan', provider: 'anthropic', name: 'Claude', email: 'a@example.com', plan: 'pro', active: true, status: 'ok', checkedAt: now,
            windows: [{ id: 'five_hour', label: '5 小时', used: 20, total: 100, resetAt: now + 3 * 3600_000 }] },
          { key: 'a2', source: 'yan', provider: 'openai-codex', name: 'ChatGPT', email: 'b@example.com', plan: 'plus', status: 'ok', switchable: true, checkedAt: now,
            windows: [{ id: 'weekly', label: '每周', used: 85, total: 100, resetAt: now + 2 * 86400_000 }] },
          { key: 'a3', source: 'yan', provider: 'deepseek', name: 'DeepSeek', status: 'limited', checkedAt: now,
            windows: [{ id: 'monthly', label: '本月', used: 100, total: 100, exceeded: true, estimated: true, resetAt: now + 9 * 86400_000 }],
            balance: { label: '余额', amount: 3.5, currency: 'USD' } }
        ]
      })
    }
    q('wb-tab-quota')?.click()
    check(await until(() => !!q('v3-wb-quota'), 3000), '打开额度页签')
    check(!!q('v3-wb-quota-refresh'), '有刷新按钮')
    if (overridable) {
      check(await until(() => document.querySelectorAll('[data-testid^="v3-wb-quota-card-"]').length === 3, 4000), '渲染三张账号卡')
      check(q('v3-wb-quota-win-five_hour')?.dataset.tone === 'ok', '低用量窗口为 ok 色调')
      check(q('v3-wb-quota-win-weekly')?.dataset.tone === 'ask', '85% 窗口为 ask 色调')
      check(q('v3-wb-quota-win-monthly')?.dataset.tone === 'fail', '用尽窗口为 fail 色调')
      check(q('v3-wb-quota-win-monthly')?.textContent?.includes('100.0%'), '显示精确百分比')
      check(q('v3-wb-quota')?.textContent?.includes('3.50') || q('v3-wb-quota')?.textContent?.includes('$3.5'), '显示余额')
      check((q('v3-wb-quota-win-five_hour')?.querySelector('.quota-win-sub')?.textContent ?? '').length > 0, '窗口显示重置倒计时')
      check(!!q('v3-wb-quota-win-monthly')?.querySelector('.ui-badge'), '推算窗口带「推算」标记')
      check(document.querySelectorAll('[data-testid="v3-wb-quota-switch"]').length === 1, '只有可切换且非活跃的账号显示切换按钮')
      check(
        [...document.querySelectorAll('[data-testid^="v3-wb-quota-card-"]')][0]?.dataset.testid === 'v3-wb-quota-card-yan-anthropic' ||
          q('v3-wb-quota-card-yan-anthropic') !== null,
        '活跃账号卡存在'
      )
      window.yan.accountQuota = async () => { throw new Error('probe-network-down') }
      q('v3-wb-quota-refresh')?.click()
      check(await until(() => !!q('v3-wb-quota-error'), 3000), '刷新失败时显示错误行')
      check(document.querySelectorAll('[data-testid^="v3-wb-quota-card-"]').length === 3, '失败后保留上一次的数字')
      window.yan.accountQuota = realQuota
    } else {
      check(
        await until(() => document.querySelectorAll('[data-testid^="v3-wb-quota-card-"]').length > 0 || !!q('v3-wb-quota-empty') || !!q('v3-wb-quota-error'), 8000),
        '真实查询后给出卡片、空状态或错误之一'
      )
    }
    out.push('证据范围：v3 日志 / 额度页签的 DOM 行为；日志与额度数据为注入或只读查询，未切换真实账号、未调模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
