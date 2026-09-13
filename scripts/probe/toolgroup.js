/**
 * 工具调用栏的展开规则。
 *
 * 用户报的 bug（原话）：
 *   「模型调用工具时，整个工具调用栏会展开；我的意思是仅展开当前在运行的工具
 *     （除非用户主动点击展开按钮）」
 *
 * 根因：`ToolGroup` 之前写过 `open = running && streaming` —— 只要组里有一条
 * 在跑，**整组**（连同所有已结束的行）一起弹开。修法是把「正在跑」的单独
 * 渲染并自动展开，已结束的收进默认收起的组。
 *
 * 这个探针不去真跑模型（那要花 token、还不确定一次能出几条工具），而是往
 * store 里注入一条合成的助手回合 —— 断言的是**渲染规则**，与工具从哪来无关。
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
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }

  // 关掉引导层，避免遮挡
  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) click(b)
    await sleep(120)
  }

  const now = Date.now()
  const tool = (id, status, cmd, extra = {}) => ({
    id,
    name: 'bash',
    args: { command: cmd },
    status,
    output: `${cmd}: done`,
    startedAt: status === 'running' ? now : now - 2000,
    endedAt: status === 'running' ? undefined : now - 1000,
    ...extra
  })
  const assistant = (id, tools) => ({ id, role: 'assistant', text: '', toolCalls: tools })

  const inject = async (tools, streamingId, suffix = '') => {
    const uid = 'u-toolgroup' + suffix
    const aid = 'a-toolgroup' + suffix
    store.setState({
      messages: [
        { id: uid, role: 'user', text: '跑几个命令' },
        assistant(aid, tools)
      ],
      streamingId
    })
    await until(() => !!q(`.msg[data-turn-id="${aid}"]`))
    await sleep(200)
    return aid
  }

  /* ---- 1. 一条在跑 + 两条已结束 ---- */
  out.push('=== 1. 只有正在运行的那条展开 ===')
  await inject(
    [tool('t1', 'ok', 'echo one'), tool('t2', 'ok', 'echo two'), tool('t3', 'running', 'sleep 30')],
    'a-toolgroup'
  )

  const runningRow = q('.trow[data-state="running"]')
  ok(!!runningRow, '渲染出了运行中的工具行')
  ok(!!runningRow && runningRow.classList.contains('open'), '运行中的行**已展开**（详情可见）')
  ok(!!runningRow && !!runningRow.querySelector('.term'), '运行中的行里有终端详情')

  const group = q('.tgroup')
  ok(!!group, '已结束的工具收进了折叠组')
  ok(!!group && !group.classList.contains('open'), '折叠组**默认收起**（这是 bug 的正题）')
  ok(qa('.tgroup-body .trow').length === 0, '收起时组内的已完成行不占位')

  const visibleRows = qa('.trow').length
  ok(visibleRows === 1, `屏幕上只看到一个工具行（实际 ${visibleRows}）`)

  /* ---- 2. 用户主动点击后组才展开 ---- */
  out.push('')
  out.push('=== 2. 用户主动点击才展开 ===')
  if (group) {
    click(q('.tgroup-head'))
    await sleep(250)
    const g2 = q('.tgroup')
    ok(!!g2 && g2.classList.contains('open'), '点击后折叠组展开')
    const doneRows = qa('.tgroup-body .trow')
    ok(doneRows.length === 2, `组里显示 2 条已结束的行（实际 ${doneRows.length}）`)
    ok(
      doneRows.every((r) => !r.classList.contains('open')),
      '已结束的行仍然保持一行（未自动展开详情）'
    )
    ok(
      !!q('.trow[data-state="running"]')?.classList.contains('open'),
      '运行中的行不受影响，仍展开'
    )
  }

  /* ---- 3. 全部结束后：全新的组保持收起，没有任何行自动展开 ---- */
  out.push('')
  out.push('=== 3. 结束后不再残留展开 ===')
  await inject(
    [tool('t1', 'ok', 'echo one'), tool('t2', 'ok', 'echo two'), tool('t3', 'ok', 'echo three')],
    undefined,
    '-2'
  )
  await sleep(250)
  ok(qa('.trow.open').length === 0, '没有自动展开的工具行')
  const g3 = q('.tgroup')
  ok(!!g3 && !g3.classList.contains('open'), '全新的折叠组默认保持收起')

  return out.join('\n')
})()
