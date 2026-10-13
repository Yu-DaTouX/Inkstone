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

  /*
   * 整轮用量的展示已从输入框下方的用量条改到**状态栏的花费详情浮层**
   * （输入框下只留速度 + 命中率一行），所以断言改读浮层里的键值行：
   * 先点 `sb-cost` 打开，再按标签取值。
   */
  const openCost = async () => {
    document.querySelector('[data-testid="sb-cost"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 40 && !document.querySelector('[data-testid="status-details"]'); i++) await sleep(100)
  }
  const kv = (label) => {
    const row = [...document.querySelectorAll('[data-testid="status-details"] .sb-kv-row')].find(
      (x) => (x.querySelector('dt')?.textContent ?? '') === label
    )
    return (row?.querySelector('dd')?.textContent ?? '').trim()
  }
  const note = () => document.querySelector('[data-testid="status-details"] .sb-details-note')?.textContent ?? ''
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

    await openCost()
    ok(!!document.querySelector('[data-testid="status-details"]'), '状态栏花费详情可以打开（用量展示的现行入口）')
    ok(kv('输出') === '100 tok', '输出 = 10 + 90（不是只显示最后一条）', kv('输出'))
    ok(kv('输入') === '3,000 tok', '输入 = 1000 + 2000', kv('输入'))
    /* 命中率：8000 / (3000 输入 + 8000 缓存读) = 72.72%；读取量单独一行 */
    ok(kv('缓存命中') === '72.72%', '缓存命中率 = 8000 / (3000 + 8000)', kv('缓存命中'))
    ok(kv('缓存读取') === '8,000 tok', '缓存读取量单独列出', kv('缓存读取'))
    ok(!kv('输出').startsWith('≥'), '两条都报了用量 → 不标下限')

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
    ok(kv('输出') === '≥90 tok', '有请求没报用量 → 合计标 ≥（是下限）', kv('输出'))
    ok(/下限/.test(note()), '浮层说明为什么是下限', note().slice(0, 60))

    /* ---- 3. 一条都没报 → 未知，不标下限 ---- */
    store.setState({
      messages: [
        { id: 'm0', role: 'user', text: '干活' },
        { id: 'a1', role: 'assistant', text: '答完了' }
      ]
    })
    await sleep(500)
    /* 一点用量都没有时显示「—」（未知 ≠ 下限），不能误标成 ≥ */
    ok(kv('输出') === '—' && !kv('输入').startsWith('≥'), '一条都没报 → 显示 —（未知 ≠ 下限）', kv('输出'))

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
    /* 回合页脚改成 `.tact-time`（旧 `.turn-footer-item` 已不存在），用时与 tooltip 在它上面 */
    const elapsed = footer?.querySelector('.tact-time') ?? null
    ok(!!elapsed, '回合页脚有用时项')
    const title = elapsed?.getAttribute('title') ?? ''
    ok(/等工具|waiting on tools/.test(title), '用时 tooltip 说明「其中等工具」', title)
    ok(/\b2s\b/.test(title), '等待时长是区间并集 2s（不是 3s）', title)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  } finally {
    /* 关掉浮层，别让它盖住后面的场景 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  return out.join('\n')
})()
