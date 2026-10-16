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

  const openProcess = async () => {
    for (let i = 0; i < 25; i++) {
      const toggle = q('[data-testid="turn-process-toggle"]')
      if (toggle) {
        if (toggle.getAttribute('aria-expanded') === 'false') {
          click(toggle)
          await sleep(300)
        }
        return !!q('.trow')
      }
      await sleep(200)
    }
    return false
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store.getState().settings) break
      await sleep(250)
    }
    await sleep(1200)

    await store.getState().patchSettings({ toolDetail: false, toolDetailExplicit: true })
    await sleep(300)

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
    const inject = () => store.getState().applyPush({ ch: 'sync', payload })
    inject()
    await openProcess()

    for (let i = 0; i < 40; i++) {
      if (qa('.trow').length >= 1) break
      await sleep(250)
      if (i % 6 === 5) {
        inject()
        await openProcess()
      }
    }
    out.push('  诊断 toolCalls=' + JSON.stringify((store.getState().messages[1]?.toolCalls ?? []).map(c => c.name + ':' + c.status)))
    out.push('  诊断 conn=' + store.getState().conn + ' messages=' + store.getState().messages.length + ' turns 相关 DOM=' + qa('.stream .msg, .stream-row').length)
    out.push('  诊断 .stream 存在=' + !!q('.stream') + ' innerHTML=' + JSON.stringify((q('.stream')?.innerHTML ?? '').replace(/s+/g, ' ').slice(0, 240)))

    ok(!q('[data-testid="tool-group-toggle"]'), '短组不再要求额外展开')
    const rows = qa('.trow')
    out.push(`  渲染出 ${rows.length} 个工具行（含 ToolGroup 里的）`)

    out.push('')
    out.push('=== 工具命令块表默认逐行显示 ===')
    const group = q('[data-testid="tool-group"]')
    ok(!!group, '工具调用进入同一张命令块表')
    if (group) {
      ok(qa('.tgroup .trow').length === 2, '短组里两条工具行都可见')
      ok(!group.querySelector('[data-testid="tool-group-collapse"]'), '短组不再多一层组折叠（七步以下直接列出）')
      ok(!!group.querySelector('.trow[data-state="error"]'), '失败的调用在组里仍以出错态显示')
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

      const head = okRow.querySelector('.trow-head') ?? okRow.firstElementChild
      ok(head?.getAttribute('aria-expanded') === 'false', '成功行是可展开控件（有 aria-expanded）')
      if (head) {
        click(head)
        await sleep(300)
        ok(okRow.classList.contains('open'), '关掉自动展开后，已完成的成功调用**仍然可以点开**（历史可回看）')
        const body = okRow.textContent ?? ''
        ok(/echo hi|hi/.test(body), '展开后能看到当时的输入输出')
        click(head)
        await sleep(200)
        ok(!okRow.classList.contains('open'), '再点一次能收起来')
      }
    }
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
