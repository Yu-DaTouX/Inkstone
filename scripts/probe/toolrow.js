/**
 * 工具调用行：成功默认摘要、**失败保留可展开的入口**（方案 P1 4.2）。
 *
 * 背景：`canExpand` 曾写成 `detailOn || running` —— 没开「工具详情」设置的用户
 * 遇到失败的工具调用时**连点都点不开**，只能看到一行红字。
 * 设计要的是「错误结果保留明显入口」。
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

  try {
    /*
     * 先等应用**真的挂载好**再注入。
     * 太早注入会被紧随其后的 bootstrap / pi 的 `sync` 整个冲掉 ——
     * 表现为「store 里有 2 条，但一个工具行都没渲染」。
     */
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store.getState().settings) break
      await sleep(250)
    }
    await sleep(1200)

    /* 确保「工具详情」这个设置是**关**的 —— 那才是这条断言的场景 */
    await store.getState().patchSettings({ toolDetail: false })
    await sleep(300)

    /*
     * 注入后要**反复重试**：应用自己也会收 pi 的 `sync`（它才是权威的），
     * 会把刚注入的内容覆盖掉 —— 尤其探针跑在 bootstrap 阶段时。
     * （virtual 探针里也踩过同一个坑，那边是每 4s 重注一次。）
     */
    const payload = [
      { id: 'te-user', role: 'user', text: '跑两个命令' },
      {
        id: 'te-a1',
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'te-ok', name: 'bash', args: { command: 'echo hi' }, status: 'ok', output: 'hi\n' },
          {
            id: 'te-bad',
            name: 'bash',
            args: { command: 'exit 1' },
            status: 'error',
            output: 'command failed with exit code 1\n'
          }
        ],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }
      }
    ]
    store.getState().applyPush({ ch: 'sync', payload })

    for (let i = 0; i < 40; i++) {
      if (qa('.trow').length >= 2) break
      await sleep(250)
      /* 每 1.5s 重注入一次，避免被后续 sync 覆盖 */
      if (i % 6 === 5) store.getState().applyPush({ ch: 'sync', payload })
    }
    /* 诊断：为什么没渲染 */
    out.push('  诊断 toolCalls=' + JSON.stringify((store.getState().messages[1]?.toolCalls ?? []).map(c => c.name + ':' + c.status)))
    out.push('  诊断 conn=' + store.getState().conn + ' messages=' + store.getState().messages.length + ' turns 相关 DOM=' + qa('.stream .msg, .stream-row').length)
    out.push('  诊断 .stream 存在=' + !!q('.stream') + ' innerHTML=' + JSON.stringify((q('.stream')?.innerHTML ?? '').replace(/s+/g, ' ').slice(0, 240)))

    const rows = qa('.trow')
    out.push(`  渲染出 ${rows.length} 个工具行（含 ToolGroup 里的）`)

    out.push('')
    out.push('=== 已结束的工具收进 ToolGroup，但「有失败就默认展开 + 角标标红」 ===')
    const group = q('[data-testid="tool-group"]')
    ok(!!group, '已结束的工具收进 ToolGroup（默认形态）')
    if (group) {
      const expanded = group.querySelector('[data-testid="tool-group-toggle"]')?.getAttribute('aria-expanded')
      out.push('  组标题 aria-expanded = ' + JSON.stringify(expanded))
      ok(expanded === 'true', '**组里有失败 → 默认展开**（失败不被埋在折叠里）')
      ok(group.classList.contains('has-fail'), '组带 has-fail 标记（语义钩子，不再给标题染色）')
      const badge = q('[data-testid="tool-group-fail"]')
      out.push('  失败角标: ' + JSON.stringify(badge?.textContent ?? '(无)'))
      ok(!!badge, '标题上有失败角标（一眼看出有东西挂了）')

      /*
       * 用户要求：只有「N 个失败」是红的，标题里其他字保持原来的颜色。
       * 所以拿 --err 的实际色值做基准：角标必须是它，标题必须**不是**它。
       */
      if (badge) {
        const probeEl = document.createElement('span')
        probeEl.style.color = 'var(--err)'
        document.body.appendChild(probeEl)
        const errRgb = getComputedStyle(probeEl).color
        probeEl.remove()
        const badgeCol = getComputedStyle(badge).color
        const headCol = getComputedStyle(group.querySelector('.tgroup-head')).color
        out.push(`  角标色 ${badgeCol} / 标题色 ${headCol}（--err = ${errRgb}）`)
        ok(badgeCol === errRgb, '角标是红色（--err）')
        ok(headCol !== errRgb, '标题文字没有被染红（红只留在角标上）')
      }

      ok(qa('.tgroup-body .trow').length >= 1, '展开后能看到组内的工具行')
    }

    const errRow = qa('.trow[data-state="error"]')[0]
    const okRow = qa('.trow[data-state="ok"]')[0]
    ok(!!errRow, '失败的那条带 data-state="error"（有红色标识）')
    ok(!!okRow, '成功的那条带 data-state="ok"')

    out.push('')
    out.push('=== 默认状态：都收起（不顶掉回答）===')
    ok(!!errRow && !errRow.classList.contains('open'), '失败行默认收起（一行红字 + 箭头）')
    ok(!!okRow && !okRow.classList.contains('open'), '成功行默认收起（摘要）')

    out.push('')
    out.push('=== 失败行可点开（这就是「明显入口」）===')
    if (errRow) {
      const head = errRow.querySelector('.trow-head') ?? errRow.firstElementChild
      out.push('  失败行 aria-expanded = ' + JSON.stringify(head?.getAttribute('aria-expanded')))
      if (head && errRow.getAttribute('data-state') === 'error') {
        ok(head.getAttribute('aria-expanded') !== null, '失败行是**可展开控件**（有 aria-expanded）')
      }
      if (head && !errRow.classList.contains('open')) {
        click(head)
        await sleep(300)
      }
      ok(errRow.classList.contains('open'), '失败行是打开的（能直接看到原因）')
      const body = errRow.textContent ?? ''
      out.push('  展开后能看到: ' + JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 80)))
      ok(/exit code|failed/i.test(body), '能看到失败原因')
    }

    out.push('')
    out.push('=== 检查：组内成功行的默认状态 ===')
    if (okRow) {
      out.push(`  成功行 open=${okRow.classList.contains('open')}（终态下应收起，只留一行摘要）`)
      ok(true, '（信息）成功行保持摘要，不因同组有失败而全部展开')
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
