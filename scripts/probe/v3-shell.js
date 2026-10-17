;(async () => {
  const out = []
  const check = (condition, label) => out.push(`  ${condition ? '✓' : '✗'} ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (predicate()) return true
      await wait(50)
    }
    return false
  }
  const untilAsync = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (await predicate()) return true
      } catch {
      }
      await wait(100)
    }
    return false
  }
  const query = (testId) => document.querySelector(`[data-testid="${testId}"]`)

  const openTool = async (tab) => {
    const direct = query(`wb-open-${tab}`)
    if (direct) {
      direct.click()
      await wait(200)
      return
    }
    query('wb-more-tools')?.click()
    const order = ['changes', 'preview', 'logs', 'branch', 'quota']
    const pick = () => document.querySelector(`.wb-more-menu [data-key="${tab}"]`) ?? document.querySelectorAll('.wb-more-menu [role="menuitem"]')[order.indexOf(tab)]
    for (let i = 0; i < 40 && !pick(); i++) await wait(50)
    pick()?.click()
    await wait(200)
  }
  const store = window.__yanStore
  const oldAnswer = store?.getState().answerApproval
  const oldApprovals = store?.getState().approvals
  let onNativeKey
  try {
    out.push('=== v3 独立外壳与真实 Chromium 按键 ===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && query('v3-sidebar')), 'v3 外壳已挂载')
    if (!store || !query('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    check(!document.querySelector('.app-shell'), '没有同时挂载 v2 外壳')
    check(!!document.querySelector('[data-testid="composer-input"]'), '正式输入框已挂载')
    check(await until(() => !!query('v3-empty')), '新会话空态已挂载')
    check(await until(() => { const el = query('v3-ascii-field'); return !!el && el.getAttribute('data-closing') === '0' }), '空态挂载动态 ASCII 背景（未淡出）')
    check(document.querySelectorAll('.wb-pane').length === 0, '默认关闭的工作区没有提前挂载叶子')
    const runsSnapshot = await window.yan.runs.snapshot()
    check(Number.isInteger(runsSnapshot.revision) && Array.isArray(runsSnapshot.runs), '正式运行快照 IPC 可用，未以渲染端伪造状态替代')
    const sidebarWidth = query('v3-sidebar').getBoundingClientRect().width
    check(sidebarWidth >= 250 && sidebarWidth <= 280, `默认侧栏宽度 ${sidebarWidth.toFixed(1)}px`)
    check(document.documentElement.scrollWidth <= innerWidth + 1, '默认宽度无页面横向溢出')
    check(!getComputedStyle(document.body).fontFamily.toLowerCase().includes('maple'), 'v3 不以随包 Maple 字体排版')
    const aligned = (container, label) => {
      const icon = container?.querySelector('svg')
      const text = container?.querySelector(label)
      if (!icon || !text) return false
      const a = icon.getBoundingClientRect()
      const b = text.getBoundingClientRect()
      return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) <= 1.5
    }
    check(aligned(document.querySelector('.mtp-trigger'), '.mtp-model'), '模型按钮图标与标签在同一行')
    check(aligned(document.querySelector('.composer-permission'), '.cp-label'), '权限按钮图标与标签在同一行')

    const headerSettings = query('v3-header-settings')
    check(!!headerSettings, '设置入口存在')
    headerSettings?.click()
    check(await until(() => query('v3-theme-light')), '精简设置页打开')
    query('v3-theme-light')?.click()
    check(await until(() => document.documentElement.dataset.theme === 'light'), '可切换浅色主题')
    const lightBg = getComputedStyle(document.body).backgroundColor
    query('v3-theme-dark')?.click()
    check(await until(() => document.documentElement.dataset.theme === 'dark'), '可切换深色主题')
    check(lightBg !== getComputedStyle(document.body).backgroundColor, '亮暗主题实际背景不同')
    const asciiToggle = query('v3-ascii-background-toggle')
    check(!!asciiToggle, '外观分区有动态背景开关')
    const asciiSwitch = () => query('v3-ascii-background-toggle')?.querySelector('input[role="switch"]')
    check(!!asciiSwitch(), '动态背景开关内部是 role="switch" 的输入')
    check((await window.yan.getSettings()).asciiBackground === undefined, '动态背景缺省不写该键（视为开）')
    asciiSwitch()?.click()
    check(await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === false), '关掉开关后主进程持久化 false')
    check(asciiSwitch()?.checked === false, '关闭后内部输入不再选中')
    query('v3-back')?.click()
    check(await until(() => query('composer-input')), '可返回会话')
    check(await until(() => !query('v3-ascii-field')), '关掉开关后空态不再挂载 ASCII 背景')
    query('v3-header-settings')?.click()
    check(await until(() => query('v3-ascii-background-toggle')), '可再次打开外观分区')
    check(await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === false, 2000), '恢复前确认开关实际已关闭（主进程回显 false）')
    asciiSwitch()?.click()
    check(await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === undefined), '开回来只回落缺省，不写 true')
    query('v3-back')?.click()
    check(await until(() => query('composer-input')), '返回会话')
    check(await until(() => !!query('v3-ascii-field')), '恢复缺省后空态重新挂载 ASCII 背景')
    query('composer-input')?.focus()
    check(await until(() => query('v3-command-input'), 20000), '真实 Ctrl+K 打开命令面板')
    check(document.activeElement === query('v3-command-input'), '命令面板接管搜索焦点')
    check(await until(() => [...document.querySelectorAll('.cmd-option__label')].some((el) => /并排|side by side/i.test(el.textContent ?? ''))), '命令面板有「并排打开」入口')
    check(await until(() => !query('v3-command-input'), 5000), '真实 Esc 关闭命令面板')
    const focusRestored = await until(() => document.activeElement === query('composer-input'), 500)
    check(focusRestored, '关闭命令面板后归还输入框焦点')
    if (!focusRestored) out.push(`    焦点诊断：${document.activeElement?.tagName} ${document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? ''}`)

    const state = store.getState()
    const pending = {
      id: 'v3-probe-approval', kind: 'danger', tool: 'bash',
      title: '界面夹具：确认卡的 Enter 安全性', detail: 'echo isolated-ui-fixture',
      reasons: ['这只是界面夹具，不会执行命令。'], cwd: state.session?.cwd ?? '',
      sessionId: state.session?.sessionId, canRemember: false, createdAt: Date.now()
    }
    const answered = []
    store.setState({
      approvals: [pending],
      answerApproval: async (id, choice) => {
        answered.push({ id, choice })
        store.setState({ approvals: [] })
      }
    })
    check(await until(() => query('v3-approval-once')), '正式确认卡显示夹具请求')
    query('v3-approval-once')?.focus()
    let nativeEnterSeen = false
    let approvalFocusedAtEnter = false
    onNativeKey = (event) => {
      if (event.key !== 'Enter') return
      nativeEnterSeen = true
      approvalFocusedAtEnter = event.target === query('v3-approval-once') && document.activeElement === query('v3-approval-once')
    }
    window.addEventListener('keyup', onNativeKey, true)
    check(await until(() => nativeEnterSeen, 10000), '收到真实 Chromium Enter 按键')
    check(approvalFocusedAtEnter, '真实 Enter 到达时焦点和事件目标确实仍是允许按钮')
    await wait(100)
    check(answered.length === 0, '允许按钮已聚焦时，Enter 仍不会触发允许')
    window.removeEventListener('keyup', onNativeKey, true)
    onNativeKey = undefined
    store.setState({ approvals: [pending] })
    await until(() => query('v3-approval-once'))
    query('v3-approval-once')?.click()
    check(await until(() => answered.length > 0), '明确点击可以答复确认卡')
    check(answered.at(-1)?.id === pending.id && answered.at(-1)?.choice === 'once', '明确点击仅答复原请求一次')
    store.setState({ approvals: oldApprovals, answerApproval: oldAnswer })

    check(['terminal', 'files', 'browser'].every((tab) => !!query(`wb-open-${tab}`)) && !!query('wb-more-tools'), '工作区有明确打开入口（标题栏工具按钮与更多工具）')
    await openTool('files')
    check(await until(() => {
      const panel = document.querySelector('.wb-panel')
      return panel && !panel.hidden && panel.getBoundingClientRect().width > 0
    }), '工作区点击后实际可见')
    const panel = document.querySelector('.wb-panel')
    for (const tab of ['changes', 'browser', 'preview']) await openTool(tab)
    check(['changes', 'files', 'browser', 'preview'].every((tab) => query(`wb-tab-${tab}`)), '打开过的工具页签都挂载')
    check(!!query('wb-split') && !!query('wb-focus'), '拆分与专注控件有明确入口')
    check(!!query('wb-popout') && query('wb-popout').disabled === true, '弹出为禁用占位（未迁移）')
    const noOwner = () => !!query('wb-empty')
    query('wb-tab-files')?.click()
    check(await until(() => query('v3-files') || noOwner()), '文件页显示真实组件或明确的无会话门闩')
    const browserWasOpen = store.getState().browserState.open
    query('wb-tab-browser')?.click()
    check(await until(() => query('wb-pane-browser') || noOwner()), '浏览器页可选中且保留归属门闩')
    await wait(150)
    check(store.getState().browserState.open === browserWasOpen, '只选择浏览器页不会自行打开或导航原生网页')
    check(!query('terminal-pane'), '探针未挂载终端，不执行用户默认 shell/profile')
    const frame = panel?.getBoundingClientRect()
    check(frame && frame.left >= -1 && frame.right <= innerWidth + 1, '工作区保持在窗口可读范围内')
    query('wb-close')?.click()
    check(await until(() => panel?.getBoundingClientRect().width === 0), '关闭后工作区实际隐藏，而不是只改状态')
    await openTool('changes')
    check(await until(() => panel && !panel.hidden && panel.getBoundingClientRect().width > 0), '重新打开保留面板，不创建终端资源')
    check(document.querySelectorAll('.wb-pane').length <= 6, '叶子实例数量不随操作增加')

    store.getState().openSettings('auth')
    check(await until(() => query('ms-tab-services')), '模型与服务正式懒加载入口可挂载')
    query('v3-settings-nav-appearance')?.click()
    check(await until(() => query('v3-theme-dark')), '设置内可切回外观分区')
    store.getState().openSettings('sync')
    check(await until(() => query('v3-sync-settings')), '设置「同步」分区有正式入口')
    query('v3-back')?.click()
    check(await until(() => query('composer-input')), '同步分区可返回对话')
    store.getState().openSettings('shortcuts')
    check(await until(() => query('v3-shortcuts-settings')), '设置「快捷键」分区有正式入口')
    check(await until(() => document.querySelectorAll('[data-testid^="v3-shortcut-record-"]').length > 0), '快捷键表有可改绑入口')
    query('v3-back')?.click()
    check(await until(() => query('composer-input')), '快捷键分区可返回对话')
    store.getState().openSettings('auth')
    check(await until(() => query('ms-tab-services')), '设置内重复同一深链接仍选中目标页')
    query('v3-back')?.click()
    check(await until(() => query('composer-input')), '深链接后可返回对话')
    store.getState().openSettings('auth')
    check(await until(() => query('ms-tab-services')), '返回对话后再次打开同页不被吞掉')
    query('v3-back')?.click()
    await until(() => query('composer-input'))
    store.getState().openSettings('packages')
    check(await until(() => query('caps-settings')), '能力与插件正式懒加载入口可挂载')
    check(['connections', 'skills', 'extensions', 'market', 'prompts'].every((tab) => query(`caps-tab-${tab}`)), '能力页五个分区入口都有明确位置')
    query('v3-back')?.click()
    check(await until(() => query('composer-input')), '能力页返回对话，不执行配置写入')

    out.push('')
    out.push('--- 首页用量（正式取数 / v3 pattern / pane 布局）---')
    const usageExpect = { main: 3000, sub: 5000, messages: 4 }
    check(await until(() => !!document.querySelector('.v3-empty-page'), 6000), '空态根节点带 v3-empty-page')
    const emptyPage = document.querySelector('.v3-empty-page')
    const paneWidth = emptyPage ? emptyPage.getBoundingClientRect().width : innerWidth
    const paneNarrow = paneWidth <= 760
    out.push(`  pane 宽度 ${paneWidth.toFixed(1)}px / window ${innerWidth}px（窄容器=${paneNarrow}）`)
    check(Math.abs(paneWidth - innerWidth) > 1, '用量容器按对话 pane 取宽，不是整个 window')
    const containerType = emptyPage ? getComputedStyle(emptyPage).containerType : ''
    check(String(containerType).includes('inline-size'), `v3-empty-page 真实 CSS 已加载（container-type=${containerType}）`)
    check(!!query('usage-overview'), '空态右栏渲染用量面板（正式组件，不是静态占位）')
    const usageDisplay = query('usage-overview') ? getComputedStyle(query('usage-overview')).display : 'missing'
    check(paneNarrow ? usageDisplay === 'none' : usageDisplay !== 'none', `对话列${paneNarrow ? '窄' : '宽'}时用量面板${paneNarrow ? '收起' : '展开'}（display=${usageDisplay}）`)

    const statsAll = await window.yan.usageStats('all')
    const stats30 = await window.yan.usageStats('30d')
    const stats7 = await window.yan.usageStats('7d')
    check(statsAll.range === 'all' && stats30.range === '30d' && stats7.range === '7d', '三个阶段各自回显范围（同一正式 IPC）')
    check(statsAll.tokens === statsAll.tokenBreakdown.main + statsAll.tokenBreakdown.subagents, '总量 = 主会话 + 子代理（同一次结果内自洽）')
    check(
      statsAll.tokenBreakdown.main === usageExpect.main && statsAll.tokenBreakdown.subagents === usageExpect.sub,
      `all：主 ${statsAll.tokenBreakdown.main} / 子 ${statsAll.tokenBreakdown.subagents} token（真实原生 JSONL）`
    )
    check(
      stats30.tokenBreakdown.main === usageExpect.main && stats30.tokenBreakdown.subagents === usageExpect.sub,
      '30d：与 all 同范围结果一致（主会话在 15 天前，仍在窗口内）'
    )
    check(
      stats7.tokenBreakdown.main === 0 && stats7.tokenBreakdown.subagents === usageExpect.sub,
      '7d：主会话 0、只有子代理 token（真实取数，不是前端造的）'
    )
    check(
      statsAll.sessions === 1 && statsAll.messages === usageExpect.messages,
      `all：会话 ${statsAll.sessions} / 消息 ${statsAll.messages} 只计主会话，不含子代理`
    )
    check(stats7.sessions === 0 && stats7.messages === 0, '7d：主会话会话/消息计数为 0')
    check(
      (statsAll.models ?? []).some((m) => m.key === 'fixture/usage-main' && m.tokens === usageExpect.main + usageExpect.sub),
      'all：模型用量含合成主/子模型且已合并'
    )
    check(
      (stats7.models ?? []).some((m) => m.key === 'fixture/usage-main' && m.tokens === usageExpect.sub),
      '7d：只有子代理那次 5000 token'
    )

    if (!paneNarrow) {
      const usageTabs = (control) => [...document.querySelectorAll(`[data-usage-control="${control}"] [role="tab"]`)]
      const clickRange = async (label) => {
        const tab = usageTabs('range').find((el) => (el.textContent ?? '').trim() === label)
        tab?.click()
        if (!tab) return false
        return until(() => tab.getAttribute('aria-selected') === 'true', 4000)
      }
      check(await until(() => (query('usage-tokens')?.textContent ?? '').includes('8,000'), 6000), '概览主数字显示 8,000（all）')
      check(
        !query('usage-token-breakdown'),
        '概览只显示总数，不拆主会话 / 子代理'
      )
      check(await clickRange('7 天'), '点「7 天」范围页签切换选中')
      check(await until(() => (query('usage-tokens')?.textContent ?? '').includes('5,000'), 5000), '7 天主数字 5,000（只子代理）')
      check(
        !query('usage-token-breakdown'),
        '7 天同样不拆分'
      )
      check(await clickRange('30 天'), '点「30 天」范围页签切换选中')
      check(await until(() => (query('usage-tokens')?.textContent ?? '').includes('8,000'), 5000), '30 天主数字回到 8,000')
      check(await clickRange('全部'), '点「全部」范围页签切回')
      const modelsTab = usageTabs('tab').find((el) => (el.textContent ?? '').trim() === '模型')
      modelsTab?.click()
      check(await until(() => !!document.querySelector('.start-models .start-model'), 4000), '「模型」页按 cost 展示模型列表')
      check((document.querySelector('.start-models')?.textContent ?? '').includes('usage-main'), '模型列表含合成模型名（provider/model 回退显示）')
      const backTab = usageTabs('tab').find((el) => (el.textContent ?? '').trim() === '概览')
      backTab?.click()
      await until(() => !!query('usage-tokens'), 3000)
      const rangeTab = usageTabs('range').find((el) => el.getAttribute('aria-selected') === 'true')
      const beforeKey = rangeTab?.textContent?.trim() ?? ''
      rangeTab?.focus()
      rangeTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      rangeTab?.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
      check(
        await until(() => usageTabs('range').some((el) => el.getAttribute('aria-selected') === 'true' && el.textContent?.trim() !== beforeKey), 3000),
        '键盘方向键切换范围页签（合成 KeyboardEvent；非真实 Chromium 输入）'
      )
      await clickRange('全部')
      await wait(2400)
    }

    const splitStore = window.__yanSplit
    if (splitStore && !paneNarrow) {
      const st = store.getState()
      const current = {
        peekedSessionId: st.peekedSessionId,
        peekedPath: st.peekedPath,
        session: st.session ? { sessionId: st.session.sessionId, sessionFile: st.session.sessionFile } : null
      }
      const candidate = (st.sessions ?? []).find((s) => s.path && s.id !== st.session?.sessionId)
      if (candidate) {
        splitStore.getState().open({ sessionId: candidate.id, path: candidate.path }, current)
        const narrowed = await until(() => {
          const page = document.querySelector('.v3-empty-page')
          return !!page && page.getBoundingClientRect().width <= 760
        }, 6000)
        const page = document.querySelector('.v3-empty-page')
        const splitPaneWidth = page ? page.getBoundingClientRect().width : null
        out.push(`  并排后 pane 宽度 ${splitPaneWidth == null ? 'n/a' : splitPaneWidth.toFixed(1)}px / window ${innerWidth}px`)
        check(narrowed && !!page && Math.abs(page.getBoundingClientRect().width - innerWidth) > 100, '同一个宽 window 并排后对话 pane 明显收窄')
        check(
          !!query('usage-overview') && getComputedStyle(query('usage-overview')).display === 'none',
          '对话 pane 收窄到阈值内时用量面板收起（按 pane 而不是 window）'
        )
        await wait(2400)
        splitStore.getState().close()
        await until(() => {
          const p = document.querySelector('.v3-empty-page')
          return !!p && p.getBoundingClientRect().width > 760
        }, 6000)
        check(
          !!query('usage-overview') && getComputedStyle(query('usage-overview')).display !== 'none',
          '关闭并排、pane 变宽后用量面板重新展开'
        )
      } else {
        out.push('  ~ 跳过并排收窄：隔离会话表里没有可并排的第二条会话')
      }
    }

    {
      const shotSettings = query('v3-header-settings')
      shotSettings?.click()
      await until(() => !!query('v3-theme-light'), 5000)
      query('v3-theme-light')?.click()
      await until(() => document.documentElement.dataset.theme === 'light', 4000)
      query('v3-back')?.click()
      await until(() => !!document.querySelector('.v3-empty-page'), 4000)
      await wait(2600)
      shotSettings?.click()
      await until(() => !!query('v3-theme-dark'), 5000)
      query('v3-theme-dark')?.click()
      await until(() => document.documentElement.dataset.theme === 'dark', 4000)
      query('v3-back')?.click()
      await until(() => !!query('composer-input'), 4000)
      await wait(1200)
    }

    await openTool('changes')
    await until(() => panel && !panel.hidden && panel.getBoundingClientRect().width > 0)

    store.getState().applyPush({ ch: 'sync', payload: [
      { id: 'v3-ui-fixture-u1', role: 'user', text: '请检查这次 UI 升级的进度。' },
      { id: 'v3-ui-fixture-a1', role: 'assistant', text: '界面采用侧栏 + 对话。基础控件、消息与输入区域正在逐项整合。\n\n- 旧界面仍为默认\n- 运行状态由主进程提供\n- 未验收的能力不会标记为完成\n\n```ts\nconst uiVersion = "v3"\n```' },
      { id: 'v3-ui-fixture-u2', role: 'user', text: '保持简洁，并保留安全确认。' },
      { id: 'v3-ui-fixture-a2', role: 'assistant', text: '好的。这里显示的是隔离界面夹具，**没有调用真实模型**。', artifacts: [{
        id: 'v3-fixture-unavailable', sourceId: 'v3-ui-fixture-a2',
        filename: 'UI 夹具（不可用成果）.bin', path: '', mediaType: 'application/octet-stream',
        kind: 'binary', bytes: 0, createdAt: Date.now(), previewable: false, unavailable: true
      }] }
    ] })
    check(await until(() => document.body.textContent.includes('隔离界面夹具')), '消息投影可以显示隔离会话夹具')
    check(await until(() => query('v3-artifact-list') && query('v3-artifact-card')), '正式回合已接成果卡，缺失文件夹具不触发真实文件读取')
    check(document.documentElement.scrollWidth <= innerWidth + 1, '正文与代码块不造成页面横向溢出')
    check(await until(() => !query('v3-ascii-field')), '离开空态后动态 ASCII 背景淡出并卸载')
    const queueBefore = store.getState().queue
    store.setState({ queue: { steering: [], followUp: [{ id: 'v3-fixture-queue-1', text: '隔离夹具：排队中的消息' }] } })
    check(await until(() => query('queue-edit-start')), '队列项有编辑入口')
    query('queue-edit-start')?.click()
    check(await until(() => query('queue-edit-panel')), '队列编辑面板可打开')
    query('queue-edit-cancel')?.click()
    check(await until(() => !query('queue-edit-panel')), '队列编辑面板可取消')
    store.setState({ queue: queueBefore })
    const modelsBefore = store.getState().models
    store.setState({ models: [{ id: 'v3-fixture-price', name: '价格夹具', provider: 'fixture', api: 'openai', reasoning: false, contextWindow: 200000, cost: { input: 3, output: 15 } }] })
    query('model-picker')?.click()
    check(await until(() => !!document.querySelector('.mtp-item-name')) && !document.querySelector('.mtp-tag-price'), '模型菜单显示模型，不显示价格')
    query('model-picker')?.click()
    check(await until(() => !document.querySelector('.mtp-tag-price')), '关闭选择器后价格标签卸载')
    store.setState({ models: modelsBefore })

    const runsStore = window.__yanRuns
    check(!!runsStore, '运行镜像 store 在隔离探针中可用')
    if (runsStore) {
      const now = Date.now()
      const sessionId = store.getState().session?.sessionId ?? 'v3-fixture-session'
      const sessionPath = 'v3-fixture://subagents'
      const parentRunId = 'v3-fixture-run-parent'
      const children = [
        ['1', 'S12·1', '审查样式依赖检查器', { kind: 'running', since: now - 70_000, activity: 'tool', tool: { name: 'bash', label: '检查样式依赖', callId: 'fixture-call-1' } }],
        ['2', 'S12·2', '核对运行投影归属', { kind: 'running', since: now - 40_000, activity: 'streaming' }],
        ['3', 'S12·3', '确认删除本轮临时产物', { kind: 'needs-you', since: now - 30_000, request: { id: 'fixture-req-3', type: 'danger', summary: '删除 .tmp/v3-ui 下的临时截图' } }],
        ['4', 'S12·4', '整理截图证据清单', { kind: 'stalled', since: now - 25_000, cause: 'no-output' }],
        ['5', 'S12·5', '更新公开文档索引', { kind: 'done', at: now - 10_000, seen: false }]
      ].map(([index, code, title, phase]) => ({
        runId: `v3-fixture-run-${index}`,
        code,
        kind: 'subagent',
        sessionId,
        sessionPath,
        parentRunId,
        title,
        startedAt: now - Number(index) * 20_000,
        phase,
        counts: { tools: Number(index) + 2, edits: index === '2' ? 1 : 0, errors: 0 }
      }))
      runsStore.setState({
        runs: [
          {
            runId: parentRunId,
            code: 'S12',
            kind: 'session',
            sessionId,
            sessionPath,
            title: 'Inkstone v3 界面升级检查',
            startedAt: now - 95_000,
            phase: { kind: 'running', since: now - 95_000, activity: 'subagent' },
            model: { provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash' },
            counts: { tools: 14, edits: 2, errors: 0 }
          },
          ...children
        ],
        syncing: false,
        error: null
      })
      await openTool('files')
      query('wb-close')?.click()
      await wait(9000)
      query('v3-runs-entry')?.click()
      check(await until(() => !!document.querySelector('.runs-page')), '运行总览可以打开')
      check(await until(() => document.querySelectorAll('.runs-row').length === 6), '运行总览列出 1 条会话 + 5 条子代理')
      const runsText = document.querySelector('.runs-page')?.textContent ?? ''
      check((runsText.match(/子 Agent/g) ?? []).length >= 5, '五条子代理都按「子 Agent」标注，不冒充会话')
      check(
        ['运行中', '等你确认', '无响应', '已完成'].every((word) => runsText.includes(word)),
        '五个子代理的不同阶段各自显示真实状态词'
      )
      check(runsText.includes('S12·3') && runsText.includes('S12·5'), '子代理编号与会话编号区分显示')
      check(document.documentElement.scrollWidth <= innerWidth + 1, '运行总览不造成页面横向溢出')
      check(await until(() => !!query('runs-history-date')), '运行历史区有时间线日期入口')
      check(document.querySelectorAll('.runs-history-view button').length === 2, '时间线 / 列表视图切换入口存在')
    }
    query('wb-tab-changes')?.click()
    await wait(50)
    const endPanel = document.querySelector('.wb-panel')
    if (endPanel && !endPanel.hidden) query('wb-close')?.click()
    await wait(100)
    check(
      !document.querySelector('[data-testid="terminal-pane"]') &&
        !document.querySelector('.term-pane') &&
        !document.querySelector('[data-testid="terminal-host"]'),
      '场景结束前 DOM 未挂载任何终端面板'
    )
    const endTerminals = await window.yan.terminal.list().catch(() => null)
    check(Array.isArray(endTerminals) && endTerminals.length === 0, '场景结束前宿主终端表为空，没有隐式创建真实 PTY')
    let savedTab = 'unknown'
    try {
      const rawPref = JSON.parse(localStorage.getItem('inkstone.v3.prefs') ?? 'null')
      savedTab = rawPref?.workbenchTab ?? 'none'
    } catch {
      savedTab = 'unreadable'
    }
    check(savedTab !== 'terminal' && savedTab !== 'browser', `场景结束时持久化页签不是终端 / 浏览器（实际 ${savedTab}）`)
    out.push('证据范围：界面夹具、真实 Chromium 按键与截图；不代表真实模型或完整工作流验收。')
    if (window.yan.isProbe) await wait(12000)
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  } finally {
    if (onNativeKey) window.removeEventListener('keyup', onNativeKey, true)
    if (store && oldAnswer) store.setState({ approvals: oldApprovals, answerApproval: oldAnswer })
  }
  return out.join('\n')
})()
