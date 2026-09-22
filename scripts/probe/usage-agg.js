/*
 * 整轮用量聚合与工具等待分段（实施-11 H-6b，cost 0）。
 *
 * 验的是**接进界面之后**的三条边界：
 *   · 一个回合里多条助手消息（多轮工具调用）的 usage **相加**显示，
 *     不是只显示最后一次请求；
 *   · 回合内有请求没报用量时，合计标成下限（`≥` + tooltip 说明）；
 *   · 回合页脚的用时 tooltip 给出「其中等工具 N」（waitSpans 区间并集）。
 *
 * 纯函数分支（相加 / partial / 区间并集）由 `test-turns.mjs` 与
 * `test-turn-timing-store.mjs` 钉死；这里只管「接线接对了没有」。
 * 真实 provider 的单请求链路仍由 cost 1 的 `tokens` 场景覆盖。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (c || extra === undefined ? '' : `（实际 ${JSON.stringify(extra)}）`))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  const item = (label) =>
    [...document.querySelectorAll('.usagebar .ub-item')].find(
      (x) => x.querySelector('.ub-label')?.textContent === label
    )
  /* 取数值本身：`.ub-value` 里还嵌着单位 / 命中率 / live 点，去掉它们再比较 */
  const val = (label) => {
    const v = item(label)?.querySelector('.ub-value')
    if (!v) return ''
    const clone = v.cloneNode(true)
    clone.querySelectorAll('.ub-unit, .ub-extra, .ub-live').forEach((x) => x.remove())
    return (clone.textContent ?? '').trim()
  }
  const tip = (label) => item(label)?.getAttribute('title') ?? ''
  const tool = (id, name, startedAt, endedAt) => ({
    id,
    name,
    args: {},
    status: 'ok',
    startedAt,
    endedAt
  })
  const usage = (o = {}) => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    ...o
  })

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready') break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(300)

    /* ---- 1. 多轮工具调用：整轮用量相加 ---- */
    store.setState({
      session: { ...store.getState().session, isStreaming: false },
      messages: [
        { id: 'm0', role: 'user', text: '干活' },
        {
          id: 'a1',
          role: 'assistant',
          text: '先看看',
          toolCalls: [tool('t1', 'bash', Date.now() - 5000, Date.now() - 3500)],
          usage: usage({ input: 1000, output: 10, totalTokens: 1010 })
        },
        {
          id: 'a2',
          role: 'assistant',
          text: '干完了',
          elapsedMs: 5000,
          usage: usage({ input: 2000, output: 90, cacheRead: 8000, totalTokens: 10090 })
        }
      ]
    })
    await sleep(700)

    ok(val('输出') === '100', `输出 = 10 + 90（不是只显示最后一条）`, `实际 ${JSON.stringify(val('输出'))}`)
    ok(val('输入') === '3.00k', '输入 = 1000 + 2000（缩写 3.00k）', `实际 ${JSON.stringify(val('输入'))}`)
    ok(val('缓存') === '8.00k', '缓存读 = 0 + 8000', `实际 ${JSON.stringify(val('缓存'))}`)
    ok(!val('输出').startsWith('≥'), '两条都报了用量 → 不标下限')

    /* ---- 2. 有请求没报用量 → 标成下限并说明 ---- */
    store.setState({
      messages: [
        { id: 'm0', role: 'user', text: '干活' },
        {
          id: 'a1',
          role: 'assistant',
          text: '先看看',
          toolCalls: [tool('t2', 'bash', Date.now() - 4000, Date.now() - 2500)]
        },
        { id: 'a2', role: 'assistant', text: '干完了', usage: usage({ input: 2000, output: 90 }) }
      ]
    })
    await sleep(600)
    ok(val('输出') === '≥90', '有请求没报用量 → 合计标 ≥（是下限）', `实际 ${JSON.stringify(val('输出'))}`)
    ok(/下限|lower bound/.test(tip('输出')), '悬停说明为什么是下限', tip('输出').slice(0, 60))

    /* ---- 3. 一条都没报 → 未知，不标下限 ---- */
    store.setState({
      messages: [
        { id: 'm0', role: 'user', text: '干活' },
        { id: 'a1', role: 'assistant', text: '答完了' }
      ]
    })
    await sleep(500)
    ok(val('输出') === '—', '一条都没报 → 显示 —（未知 ≠ 下限）', `实际 ${JSON.stringify(val('输出'))}`)

    /* ---- 4. 回合页脚：用时的 tooltip 给出工具等待 ---- */
    store.setState({
      session: { ...store.getState().session, isStreaming: false },
      messages: [
        { id: 'm0', role: 'user', text: '干活' },
        {
          id: 'a1',
          role: 'assistant',
          text: '先看看',
          // 两段**重叠**的工具等待：区间并集 = 2000ms，逐段相加会是 3000ms
          toolCalls: [tool('t3', 'bash', 1_000_000, 1_002_000), tool('t4', 'read', 1_001_000, 1_002_000)],
          elapsedMs: 9000,
          usage: usage({ input: 100, output: 5 })
        }
      ]
    })
    await sleep(600)
    const footer = document.querySelector('[data-testid="turn-footer"]')
    const elapsed = footer
      ? [...footer.querySelectorAll('.turn-footer-item')].find((x) =>
          /用时|elapsed/i.test(x.textContent ?? '')
        )
      : null
    ok(!!elapsed, '回合页脚有用时项')
    const title = elapsed?.getAttribute('title') ?? ''
    ok(/等工具|waiting on tools/.test(title), '用时 tooltip 说明「其中等工具」', title)
    ok(/\b2s\b/.test(title), '等待时长是区间并集 2s（不是 3s）', title)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
