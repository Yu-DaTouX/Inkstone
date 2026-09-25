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
  /* 第三个参数是诊断值（几何/计数）：失败时看得到具体数，成功时也留痕 */
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
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

  /* ---- 1. 默认（toolDetail 关）：运行中的行也**不**自动展开 ---- */
  out.push('=== 1. 默认不自动展开（N03）===')
  await store.getState().patchSettings({ toolDetail: false, toolDetailExplicit: true })
  await sleep(200)
  await inject(
    [tool('t1', 'ok', 'echo one'), tool('t2', 'ok', 'echo two'), tool('t3', 'running', 'sleep 30')],
    'a-toolgroup'
  )

  const runningRow = q('.trow[data-state="running"]')
  ok(!!runningRow, '渲染出了运行中的工具行')
  ok(!!runningRow && !runningRow.classList.contains('open'), '运行中的行**默认收起**（只留一行）')
  ok(!!runningRow && !runningRow.querySelector('.term'), '默认不渲染终端详情（不抢版面）')
  ok(qa('.trow.open').length === 0, '整个回合没有任何自动展开的工具行')

  /* ---- 1b. 显式打开偏好：只有正在运行的那条自动展开 ---- */
  out.push('')
  out.push('=== 1b. 显式打开 toolDetail 后，只有运行中的那条展开 ===')
  await store.getState().patchSettings({ toolDetail: true, toolDetailExplicit: true })
  ok(
    await until(() => !!q('.trow[data-state="running"]')?.classList.contains('open')),
    '打开偏好后运行中的行自动展开'
  )
  ok(!!q('.trow[data-state="running"] .term'), '展开后里面有终端详情')

  const group = q('.tgroup')
  ok(!!group, '已结束的工具收进了折叠组')
  ok(!!group && !group.classList.contains('open'), '折叠组**默认收起**')
  ok(qa('.tgroup-body .trow').length === 0, '收起时组内的已完成行不占位')

  const visibleRows = qa('.trow').length
  ok(visibleRows === 1, `屏幕上只看到一个工具行（实际 ${visibleRows}）`)

  /* 还原成默认偏好，不影响后面的场景 */
  await store.getState().patchSettings({ toolDetail: false, toolDetailExplicit: true })
  await sleep(150)

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
    ok(!!q('.trow[data-state="running"]'), '运行中的行仍在（不再有自动展开可断言）')
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

  /* ---- 4. 展开长输出：不抢焦点、不跳动、不引入第二条滚动条（N03）---- */
  out.push('')
  out.push('=== 4. 展开长输出（几何与焦点）===')
  /*
   * 这一段是 N03 剩下的验收：长输出 / 并行工具 / 历史消息 / 滚动阅读下，
   * 展开工具详情不能抢焦点、不能让对话跳位、不能冒出第二个滚动条。
   *
   * 注入合成回合而不是真跑模型：这里验的是**渲染规则**，
   * 长输出只要够长（超过终端窗口高度）就够了。
   */
  const longOutput = Array.from({ length: 400 }, (_, i) => 'line ' + String(i + 1).padStart(3, '0') + ' 中文输出测试').join('\n')
  await inject(
    [
      tool('t-long', 'ok', 'cat big.log', { output: longOutput }),
      tool('t-short', 'ok', 'echo short')
    ],
    undefined,
    '-long'
  )
  await sleep(250)
  /* 组默认收起 → 先展开组，再展开其中一行 */
  click(q('.tgroup-head'))
  await sleep(250)
  const rowsLong = qa('.tgroup-body .trow')
  ok(rowsLong.length === 2, '组里两条已结束的工具行都在', String(rowsLong.length))
  const longRow = rowsLong[0]
  const shortRow = rowsLong[1]
  const listBefore = q('.stream')
  const scrollBefore = listBefore?.scrollTop ?? 0
  const topBefore = longRow?.getBoundingClientRect().top ?? 0
  const focusBefore = document.activeElement
  /* 用真实点击（行头按钮），并让焦点先落在它身上 —— 这样"抢焦点"才是可测的 */
  const head = longRow?.querySelector('.trow-head') ?? longRow
  head?.focus?.()
  const focusedNow = document.activeElement
  click(head)
  const opened = await until(() => longRow?.classList.contains('open'))
  ok(opened, '点击后这一行展开（长输出）')

  /* ① 不抢焦点：焦点仍在行头，没有被搬进详情里 */
  ok(
    document.activeElement === focusedNow || document.activeElement === head,
    '展开不抢焦点（焦点仍在行头）',
    document.activeElement?.className ?? String(document.activeElement?.tagName)
  )
  /* ② 不跳动：这一行的顶部位置与展开前一致（对话没有滚走） */
  const topAfter = longRow?.getBoundingClientRect().top ?? 0
  const scrollAfter = listBefore?.scrollTop ?? 0
  ok(
    Math.abs(topAfter - topBefore) <= 2,
    '展开后这一行没有跳位',
    `top ${Math.round(topBefore)} → ${Math.round(topAfter)}`
  )
  ok(Math.abs(scrollAfter - scrollBefore) <= 2, '对话滚动位置没有被改动', `${scrollBefore} → ${scrollAfter}`)
  /* ③ 长输出真的完整渲染（不是截断成几行） */
  const body = longRow?.querySelector('.term') ?? longRow
  const bodyText = body?.textContent ?? ''
  ok(/line 400/.test(bodyText), '长输出的结尾在 DOM 里（没有按行数截断）')
  /*
   * ④ 不出现第二条滚动条：详情内部可以有一个可滚区域（终端窗口本身就是滚动的），
   *    但不许"可滚里面再套一个可滚" —— 那才是用户说的第二条滚动条。
   */
  const scrollables = [...(body?.querySelectorAll('*') ?? [])].filter((el) => {
    const cs = getComputedStyle(el)
    return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2
  })
  const nested = scrollables.filter((el) => scrollables.some((other) => other !== el && other.contains(el)))
  ok(nested.length === 0, '详情里没有"滚动套滚动"', `可滚元素 ${scrollables.length} 个，嵌套 ${nested.length} 个`)
  const canScroll = scrollables.some((el) => {
    el.scrollTop = 10
    const moved = el.scrollTop > 0
    el.scrollTop = 0
    return moved
  })
  ok(scrollables.length === 0 || canScroll, '详情内部真的能滚动阅读长输出')

  /*
   * ⑤ 详情上限（用户 2026-09-19：「展开时应该有一个固定的范围，或者在最上方
   *    显示折叠回去的按钮」）只作用于**非终端**内容：命令类详情是终端窗口，
   *    它自带高度与缩放手柄（Terminal.tsx），若也套一层，就会在终端外面
   *    再出现一条滚动条。这里是那条排除规则的反向验证。
   */
  const termCS = getComputedStyle(body)
  out.push(`  终端窗口：max-height=${termCS.maxHeight} overflow-y=${termCS.overflowY}`)
  ok(
    termCS.maxHeight === 'none' && !/auto|scroll/.test(termCS.overflowY),
    '终端窗口没有被详情上限套住（自己管高度与缩放手柄）'
  )
  /* ⑤ 并行工具：展开第二条不影响第一条的展开状态 */
  click(shortRow?.querySelector('.trow-head') ?? shortRow)
  await sleep(250)
  ok(longRow?.classList.contains('open'), '展开另一条时，第一条仍然展开（互不影响）')
  ok(shortRow?.classList.contains('open'), '刚点的那条也展开了')
  /* 收回去，别把展开态留给后面的断言 */
  click(shortRow?.querySelector('.trow-head') ?? shortRow)
  click(head)
  await sleep(250)
  ok(qa('.trow.open').length === 0, '两条都收回去了')

  /* ---- 5. 历史消息里的工具行：滚动阅读后展开仍然不跳位 ---- */
  out.push('')
  out.push('=== 5. 历史消息（滚上去再展开）===')
  const turn = (n) => ({
    user: { id: 'u-hist' + n, role: 'user', text: '第 ' + n + ' 轮：跑个命令' },
    assistant: {
      id: 'a-hist' + n,
      role: 'assistant',
      text: '第 ' + n + ' 轮结束。',
      toolCalls: [tool('h' + n, 'ok', 'echo hist' + n)]
    }
  })
  const turns = [1, 2, 3, 4, 5, 6].map(turn)
  store.setState({
    messages: turns.flatMap((t) => [t.user, t.assistant]),
    streamingId: undefined
  })
  await sleep(400)
  const list = q('.stream')
  if (list) list.scrollTop = 0
  await sleep(300)
  const histRows = qa('.trow')
  ok(histRows.length >= 6, '多轮历史都渲染出了工具行', String(histRows.length))
  const firstHist = histRows[0]
  const histTopBefore = firstHist?.getBoundingClientRect().top ?? 0
  const histScrollBefore = list?.scrollTop ?? 0
  click(firstHist?.querySelector('.trow-head') ?? firstHist)
  const histOpened = await until(() => firstHist?.classList.contains('open'))
  ok(histOpened, '历史里的工具行能展开')
  ok(
    Math.abs((firstHist?.getBoundingClientRect().top ?? 0) - histTopBefore) <= 2,
    '滚到顶部后展开历史行也不跳位',
    `top ${Math.round(histTopBefore)} → ${Math.round(firstHist?.getBoundingClientRect().top ?? 0)}`
  )
  ok(
    Math.abs((list?.scrollTop ?? 0) - histScrollBefore) <= 2,
    '展开历史行没有改变对话滚动位置',
    `${histScrollBefore} → ${list?.scrollTop ?? 0}`
  )

  /* ---- 6. 组展开后有显示范围，不铺开整屏（用户 2026-09-19）---- */
  out.push('')
  out.push('=== 6. 组展开后有显示范围，不铺开整屏 ===')
  /*
   * 用户原话：「主动展开调用工具/命令栏的时候，给展开的条目一个显示范围，
   * 而不是铺开到整个界面」—— 他截图里那条组有 146 次调用。
   * 所以这里造一个 60 条的组：数量不重要，重要是**真的超出上限**。
   */
  await inject(
    Array.from({ length: 60 }, (_, i) => tool('m' + i, 'ok', 'echo line-' + i)),
    null,
    '-many'
  )
  await sleep(300)
  const bigGroup = q('.tgroup')
  ok(!!bigGroup, '造了一个 60 条调用的组')
  click(bigGroup?.querySelector('.tgroup-head') ?? bigGroup)
  await sleep(400)
  const gBody = q('.tgroup-body')
  const gcs = gBody ? getComputedStyle(gBody) : null
  out.push(
    `  组列表：max-height=${gcs?.maxHeight} overflow-y=${gcs?.overflowY} ` +
      `可视 ${gBody?.clientHeight}px / 内容 ${gBody?.scrollHeight}px`
  )
  ok(qa('.tgroup-body .trow').length === 60, '60 条都在 DOM 里（没有按数量截断）')
  ok(gcs && gcs.maxHeight !== 'none', '组展开后有固定上限（不再铺开到整个界面）')
  ok(gcs && /auto|scroll/.test(gcs.overflowY), '超出上限的部分自己滚动')
  ok(
    !!gBody && gBody.scrollHeight > gBody.clientHeight + 2,
    '60 条确实超出了上限（真的会滚，不是摆一个空的 max-height）'
  )
  /*
   * 高度口径：**窗口高的四分之一**。
   * 用户 2026-09-25 把三处统一成这个数（产物图片含衬底 / 推理过程 /
   * 命令列表），早先的「25 行」（2026-09-19）作废 —— 行步进随字体和
   * 缩放在变，25vh 才是现在真正的不变量，所以断言也换成 vh。
   */
  const rowsForCount = qa('.tgroup-body .trow')
  const rowStep =
    rowsForCount.length > 1
      ? rowsForCount[1].getBoundingClientRect().top - rowsForCount[0].getBoundingClientRect().top
      : 0
  const rowsInView =
    rowStep > 0 && gBody ? Math.floor((gBody.clientHeight + 1) / rowStep) : 0
  out.push(`  一屏可见约 ${rowsInView} 条（行步进 ${rowStep.toFixed(1)}px）`)
  const wantH = window.innerHeight * 0.25
  ok(
    !!gBody && Math.abs(gBody.clientHeight - wantH) <= 2,
    `列表高度 = 窗口高的 1/4（期望 ${Math.round(wantH)}px）`,
    `实测 ${gBody?.clientHeight}px`
  )
  ok(
    !!gBody && gBody.clientHeight <= window.innerHeight,
    '列表本身不超出视口',
    `${gBody?.clientHeight}px / ${window.innerHeight}px`
  )

  /* 组头在 body 外面，所以列表内部滚动时它一动不动 */
  const gHeadTop1 = q('.tgroup-head')?.getBoundingClientRect().top
  if (gBody) gBody.scrollTop = 99999
  await sleep(160)
  const gHeadTop2 = q('.tgroup-head')?.getBoundingClientRect().top
  out.push(`  列表内部滚动后组头 top ${Math.round(gHeadTop1)} → ${Math.round(gHeadTop2)}`)
  ok(gHeadTop1 === gHeadTop2, '列表内部滚动时组头不动（收起入口不会滚丢）')
  ok(!!q('.tgroup-head'), '组头（「调用了 N 次工具/命令」）仍在上方')

  /*
   * ---- 「查看失败」只看失败项 ----
   *
   * 用户：「命令调用的展示旁边的查看失败按钮 点击的时候应该是仅显示失败的项目
   * 现在是显示了全部」。原来它只做两件事：展开整组 + 展开第一条失败的详情，
   * 列表里成功行一条不少。
   */
  out.push('')
  out.push('=== 「查看失败」只显示失败项 ===')
  await inject(
    [
      tool('vf1', 'ok', 'echo 1'),
      tool('vf2', 'error', 'boom-1'),
      tool('vf3', 'ok', 'echo 2'),
      tool('vf4', 'error', 'boom-2'),
      tool('vf5', 'ok', 'echo 3')
    ],
    undefined,
    '-vf'
  )
  const vfFail = q('[data-testid="tool-group-fail"]')
  out.push('  失败角标: ' + JSON.stringify(vfFail?.textContent ?? ''))
  const vfBtn = q('.tgroup-fail-action')
  ok(!!vfBtn, '有「查看失败」按钮')
  ok(vfBtn?.textContent.trim() === '查看失败', '按钮初始文案 =「查看失败」')
  if (vfBtn) {
    click(vfBtn)
    await sleep(400)
    const vfRows = qa('.tgroup-body .trow')
    const vfErrs = vfRows.filter((r) => r.getAttribute('data-state') === 'error')
    out.push(`  过滤后：${vfRows.length} 行 / 其中失败 ${vfErrs.length}`)
    ok(vfRows.length === 2, `只剩 2 条失败行（实际 ${vfRows.length}）`)
    ok(vfRows.length > 0 && vfErrs.length === vfRows.length, '剩下的全是失败行（没混入成功的）')
    const vfBack = q('.tgroup-fail-action')
    ok(vfBack?.textContent.trim() === '显示全部', '按钮切换为「显示全部」')
    if (vfBack) {
      click(vfBack)
      await sleep(400)
      const vfAll = qa('.tgroup-body .trow')
      out.push(`  切回后：${vfAll.length} 行`)
      ok(vfAll.length === 5, `切回后 5 行都在（实际 ${vfAll.length}）`)
    }
  }

  return out.join('\n')
})()
