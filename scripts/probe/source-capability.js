/**
 * 来源搜索入口（实施-07 S4）：**有则出现**。
 *
 * ── 这一片在测什么 ──
 * 方案对网页搜索的硬条件是「**只在已发现兼容搜索能力时启用**」，且明写
 * 「不要自造私有搜索后端」。所以宿主这边的产物不是搜索本身，而是
 * **发现 + 如实暴露**：命中一条兼容搜索能力 → 来源菜单里出现入口；
 * 没命中 → 整块不渲染（不是「点了才知道不行」）。
 *
 * ── 这条场景真的在连一个搜索工具吗 ──
 * 是。场景给了一份真实 MCP 配置（官方 SDK 的 stdio fixture，工具表里有
 * `web_search`），宿主会真的连它、把工具接进能力目录 —— 判定读的就是那份目录。
 * fixture 不联网，所以整条场景 cost 0。
 *
 * 反向验证怎么做（不要写进断言）：把 fixture 里 `web_search` 那个工具改名成
 * 不带 search 语义的名字，入口就该整块消失 —— 那时本探针会红在第一节。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (btn) {
        click(btn)
        await sleep(250)
      } else await sleep(120)
    }
    for (let i = 0; i < 80; i++) {
      if (store.getState().session?.model && q('[data-testid="session-project"]')) break
      await sleep(250)
    }

    out.push('=== 1. 主进程侧：能力目录里真的有一条搜索能力 ===')
    let availability = null
    for (let i = 0; i < 40; i++) {
      availability = await window.yan.sources.webSearch().catch(() => null)
      if (availability?.available) break
      await sleep(500)
    }
    out.push('  availability = ' + JSON.stringify(availability))
    ok(availability?.available === true, '宿主报告「已发现兼容搜索能力」')
    ok(typeof availability?.location === 'string' && availability.location.length > 0, '带上可执行的调用形状')

    out.push('')
    out.push('=== 2. 来源菜单里出现了入口 ===')
    click(q('[data-testid="session-project"]'))
    await sleep(400)
    ok(!!q('[data-testid="env-menu"]'), '环境菜单打开（来源菜单挂在它里面）')
    const entry = q('[data-testid="src-websearch"]')
    ok(!!entry, '出现了网页搜索入口')
    if (!entry) {
      out.push('  菜单里的 testid：' + [...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid).filter((x) => x.startsWith('src')).join(' '))
      return out.join('\n')
    }

    const input = q('[data-testid="src-search-query"]')
    const runBtn = q('[data-testid="src-search-run"]')
    ok(!!input && !!runBtn, '入口里有关键词输入与执行按钮')
    ok(runBtn?.disabled === true, '没输入关键词时按钮是禁用的')
    out.push('  按钮文案 = ' + JSON.stringify((runBtn?.textContent ?? '').trim()))

    out.push('')
    out.push('=== 3. 点下去只写草稿（宿主自己不搜） ===')
    const snap = () => {
      const s = store.getState()
      const runner = (s.runners ?? []).find((r) => (r.runId ?? r.id) === s.activeRunnerId)
      return {
        sessionId: s.session?.sessionId ?? null,
        activeRunnerId: s.activeRunnerId ?? null,
        runnerSessionId: runner?.sessionId ?? null,
        keys: Object.keys(s.sessionRuntimes ?? {})
      }
    }
    out.push('  点击前 ' + JSON.stringify(snap()))
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (input && inputSetter) {
      inputSetter.call(input, 'electron streaming grapheme')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await sleep(200)
    ok(q('[data-testid="src-search-run"]')?.disabled === false, '有词之后按钮可用')
    click(q('[data-testid="src-search-run"]'))
    await sleep(600)
    out.push('  点击后 ' + JSON.stringify(snap()))

    const draft = q('[data-testid="composer"]')?.value ?? ''
    out.push('  草稿 = ' + JSON.stringify(draft.slice(0, 200)))
    /* 诊断：读不到草稿时要知道是「没写进去」还是「写到了另一个 key」 */
    out.push('  composer 元素 = ' + String(!!q('[data-testid="composer"]')))
    out.push(
      '  activeRunnerId=' +
        String(store.getState().activeRunnerId) +
        ' runnerKeys=' +
        JSON.stringify(Object.keys(store.getState().sessionRuntimes ?? {})) +
        ' drafts=' +
        JSON.stringify(
          Object.entries(store.getState().sessionRuntimes ?? {}).map(([k, v]) => [k, String(v?.draft ?? '').slice(0, 40)])
        )
    )
    ok(draft.includes('electron streaming grapheme'), '草稿里有刚输入的关键词')
    ok(draft.includes(String(availability?.title ?? '')), '草稿里点了名要靠哪条能力')
    ok(draft.includes(String(availability?.location ?? '')), '草稿里带上可执行的调用形状')
    /* 只是写草稿：**没有**替用户发出消息 */
    const sent = (store.getState().messages ?? []).some((m) => m.role === 'user' && String(m.text ?? '').includes('electron streaming grapheme'))
    ok(!sent, '没有自动发送（只是把草稿放进输入框，等用户确认）')
    ok(!q('[data-testid="env-menu"]'), '写完草稿后菜单自己关掉（回到输入框）')
  } catch (error) {
    out.push('  ✗ 抛异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
