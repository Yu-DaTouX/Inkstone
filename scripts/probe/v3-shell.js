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
  const closeSettings = async () => {
    query('settings-close')?.click()
    return until(() => !query('settings-root') && !!query('composer-input'))
  }
  const openSettingsFromSidebar = async () => {
    const direct = query('t3-sidebar-utility-settings')
    if (direct) direct.click()
    else {
      query('t3-sidebar-utility-more')?.click()
      await until(() => !!query('t3-sidebar-utility-menu'), 2000)
      const item = [...document.querySelectorAll('[data-testid="t3-sidebar-utility-menu"] [role="menuitem"]')]
        .find((el) => /设置|Settings/i.test(el.textContent ?? ''))
      item?.click()
    }
    return until(() => !!query('settings-root'), 4000)
  }
  const openRightPanel = async () => {
    if (query('v3-head-panel-toggle')?.getAttribute('aria-pressed') !== 'true') query('v3-head-panel-toggle')?.click()
    return until(() => !!query('rp') && (!!query('rp-hide') || !!query('rp-new-tab')), 4000)
  }
  const hideRightPanel = async () => {
    if (query('rp-hide')) query('rp-hide')?.click()
    else query('v3-head-panel-toggle')?.click()
    return until(() => query('v3-head-panel-toggle')?.getAttribute('aria-pressed') === 'false', 3000)
  }
  const store = window.__yanStore
  const oldAnswer = store?.getState().answerApproval
  const oldApprovals = store?.getState().approvals
  const browserBefore = store?.getState().browserState?.open
  let onNativeKey
  try {
    out.push('=== v3 独立外壳与真实 Chromium 按键 ===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && query('v3-sidebar')), 'v3 外壳已挂载')
    if (!store || !query('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    check(!document.querySelector('.app-shell'), '没有同时挂载 v2 外壳')
    check(!!document.querySelector('[data-testid="composer-input"]'), '正式输入框已挂载')
    check(await until(() => !!query('v3-empty')), '新会话空态已挂载')
    check(await until(() => { const el = query('v3-ascii-field'); return !!el && el.getAttribute('data-closing') === '0' }), '空态挂载动态 ASCII 背景（未淡出）')
    check(document.querySelectorAll('.wb-pane').length === 0, '旧的 wb 工作区叶子没有被挂载')
    const runsSnapshot = await window.yan.runs.snapshot()
    check(Number.isInteger(runsSnapshot.revision) && Array.isArray(runsSnapshot.runs), '正式运行快照 IPC 可用，未以渲染端伪造状态替代')
    const sidebarWidth = document.querySelector('.v3-main').getBoundingClientRect().left
    check(Math.abs(sidebarWidth - 288) <= 2, `默认侧栏宽度 ${sidebarWidth.toFixed(1)}px（参考默认 288）`)
    check(document.documentElement.scrollWidth <= innerWidth + 1, '默认宽度无页面横向溢出')
    check(!getComputedStyle(document.body).fontFamily.toLowerCase().includes('maple'), 'v3 不以随包 Maple 字体排版')
    const aligned = (container, labelSelector) => {
      const icon = container?.querySelector('svg')
      const text = container?.querySelector(labelSelector)
      if (!icon || !text) return false
      const a = icon.getBoundingClientRect()
      const b = text.getBoundingClientRect()
      return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) <= 1.5
    }
    check(
      aligned(document.querySelector('[data-chat-provider-model-picker]'), '[data-chat-provider-model-picker-label]'),
      '模型按钮图标与标签在同一行'
    )
    const permissionChip = query('v3-empty') ? document.querySelector('[data-composer-permission-trigger]') : null
    check(!!permissionChip && ['danger', 'all'].includes(permissionChip.dataset.permissionMode ?? ''), '输入框权限按钮带当前档位')
    check(!!permissionChip?.getAttribute('aria-label'), '权限按钮有可访问名')

    check(!query('v3-head-settings'), '顶栏不再单放设置按钮')
    check(!!query('v3-head-actions') && !!query('v3-always-on-top'), '顶栏操作区含窗口置顶按钮')
    check(query('v3-always-on-top')?.getAttribute('aria-pressed') !== null, '置顶按钮回显开关状态')
    check(['true', 'false'].includes(query('v3-head-panel-toggle')?.getAttribute('aria-pressed') ?? ''), '右栏按钮回显开关状态')
    check(!!query('v3-head-sessionbar-toggle') && !!query('v3-head-panel-toggle'), '顶栏有会话栏与右栏两个开关')
    check(!query('v3-head-new-chat'), '侧栏展开时顶栏不重复放「新建会话」')
    const folderNewThread = document.querySelector('[data-testid="sidebar-project-folder"] button[aria-label]')
    check(!!folderNewThread, '项目分区头部有新建会话按钮')

    out.push('')
    out.push('--- 左栏页脚设置入口 / 外观 / 动态背景 ---')
    check(await openSettingsFromSidebar(), '左栏页脚设置入口打开设置')
    query('v3-settings-nav-appearance')?.click()
    check(await until(() => query('v3-theme-light')), '设置导航进入外观分区')
    query('v3-theme-light')?.click()
    check(await until(() => document.documentElement.dataset.theme === 'light'), '可切换浅色主题')
    const lightBg = getComputedStyle(document.querySelector('.v3-main') ?? document.body).backgroundColor
    query('v3-theme-dark')?.click()
    check(await until(() => document.documentElement.dataset.theme === 'dark'), '可切换深色主题')
    check(lightBg !== getComputedStyle(document.querySelector('.v3-main') ?? document.body).backgroundColor, '亮暗主题实际背景不同')
    query('v3-appearance-advanced')?.click()
    check(await until(() => !!query('v3-home-bg-ascii'), 3000), '外观高级里有动态背景档位')
    const asciiOption = () => query('v3-home-bg-ascii')
    const asciiPressed = () => ['aria-pressed', 'aria-checked'].some((name) => asciiOption()?.getAttribute(name) === 'true')
    check(asciiPressed(), '动态背景缺省为开')
    check((await window.yan.getSettings()).asciiBackground === undefined, '动态背景缺省不写该键（视为开）')
    query('v3-home-bg-none')?.click()
    check(await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === false), '选「无」后主进程持久化 false')
    check(!asciiPressed(), '关闭后档位不再选中')
    check(await closeSettings(), '可返回会话')
    check(await until(() => !query('v3-ascii-field')), '关掉动态背景后空态不再挂载 ASCII 背景')
    check(await openSettingsFromSidebar(), '再次从页脚打开设置')
    check(await until(() => !!query('v3-settings-nav-appearance'), 3000), '重新打开回到设置页')
    query('v3-settings-nav-appearance')?.click()
    query('v3-appearance-advanced')?.click()
    check(await until(() => !!query('v3-home-bg-ascii'), 3000), '高级重新展开后可见动态背景档位')
    asciiOption()?.click()
    check(await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === true), '开回来写 true')
    check(await closeSettings(), '返回会话')
    check(await until(() => !!query('v3-ascii-field')), '恢复动态背景后空态重新挂载 ASCII 背景')
    await store.getState().patchSettings({ asciiBackground: undefined }).catch(() => undefined)

    const focusTrail = []
    const onFocusIn = (event) => focusTrail.push(`${event.target?.tagName}:${event.target?.getAttribute?.('data-testid') ?? ''}`)
    document.addEventListener('focusin', onFocusIn, true)
    query('composer-input')?.focus()
    check(await until(() => query('v3-command-input'), 20000), '真实 Ctrl+K 打开命令面板')
    check(document.activeElement === query('v3-command-input'), '命令面板接管搜索焦点')
    check(await until(() => [...document.querySelectorAll('.cmd-option')].some((el) => /并排|side by side/i.test(el.textContent ?? ''))), '命令面板有「并排打开」入口')
    check(await until(() => !query('v3-command-input'), 5000), '真实 Esc 关闭命令面板')
    const focusRestored = await until(() => document.activeElement === query('composer-input'), 500)
    check(focusRestored, '关闭命令面板后归还输入框焦点')
    document.removeEventListener('focusin', onFocusIn, true)
    if (!focusRestored) out.push(`    焦点诊断：${document.activeElement?.tagName} ${document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? ''}；轨迹 ${focusTrail.slice(-8).join(' → ')}`)

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

    out.push('')
    out.push('--- 右栏（替代旧 wb 工作区卡片）---')
    check(await openRightPanel(), '点顶栏右栏按钮打开右栏')
    check(query('v3-head-panel-toggle')?.getAttribute('aria-pressed') === 'true', '右栏按钮回显已打开')
    const panelRoot = query('rp')
    const panelBox = panelRoot?.getBoundingClientRect()
    check(!!panelBox && panelBox.left >= -1 && panelBox.right <= innerWidth + 1, '右栏保持在窗口可读范围内')
    check(
      !!query('rp-new-tab') || document.querySelectorAll('.t3-launcher__row').length > 0,
      '右栏有新建标签入口或启动器，不是空壳'
    )
    check(!query('terminal-pane') && !query('terminal-host'), '打开右栏不会自动挂载终端面板')
    check(store.getState().browserState?.open === browserBefore, '打开右栏不会自行打开或导航原生网页')
    check(await hideRightPanel(), '点右栏收起按钮关闭右栏')
    check(query('v3-head-panel-toggle')?.getAttribute('aria-pressed') === 'false', '收起后顶栏按钮回到关闭')

    store.getState().openSettings('auth')
    check(await until(() => query('ms-services')), '模型与服务正式懒加载入口可挂载')
    query('v3-settings-nav-appearance')?.click()
    check(await until(() => query('v3-theme-dark')), '设置内可切回外观分区')
    store.getState().openSettings('sync')
    check(await until(() => query('v3-data-settings')), '旧「同步」深链接进入数据与同步分区')
    check(await closeSettings(), '数据与同步分区可返回对话')
    store.getState().openSettings('shortcuts')
    check(await until(() => query('v3-shortcuts-settings')), '设置「快捷键」分区有正式入口')
    check(await until(() => document.querySelectorAll('[data-testid^="v3-shortcut-record-"]').length > 0), '快捷键表有可改绑入口')
    check(await closeSettings(), '快捷键分区可返回对话')
    store.getState().openSettings('auth')
    check(await until(() => query('ms-services')), '设置内重复同一深链接仍选中目标页')
    check(await closeSettings(), '深链接后可返回对话')
    store.getState().openSettings('auth')
    check(await until(() => query('ms-services')), '返回对话后再次打开同页不被吞掉')
    await closeSettings()
    store.getState().openSettings('packages')
    check(await until(() => query('caps-settings')), '能力与插件正式懒加载入口可挂载')
    check(['skills', 'mcp', 'tools', 'market'].every((tab) => query(`caps-tab-${tab}`)), '能力页四个分区入口都有明确位置')
    check(await closeSettings(), '能力页返回对话，不执行配置写入')

    out.push('')
    out.push('--- 首页用量（正式取数 + 详情页）---')
    const usageExpect = { main: 3000, sub: 5000, messages: 4 }
    check(await until(() => !!document.querySelector('.v3-empty-page'), 6000), '空态根节点带 v3-empty-page')
    const emptyPage = document.querySelector('.v3-empty-page')
    const paneWidth = emptyPage ? emptyPage.getBoundingClientRect().width : innerWidth
    out.push(`  pane 宽度 ${paneWidth.toFixed(1)}px / window ${innerWidth}px`)
    check(Math.abs(paneWidth - innerWidth) > 1, '空态按对话 pane 取宽，不是整个 window')
    const containerType = emptyPage ? getComputedStyle(emptyPage).containerType : ''
    check(String(containerType).includes('inline-size'), `v3-empty-page 真实 CSS 已加载（container-type=${containerType}）`)
    check(await until(() => !!query('usage-strip'), 6000), '空态渲染本机用量卡片（正式组件，不是静态占位）')
    check(await until(() => query('usage-strip')?.getAttribute('aria-busy') !== 'true', 6000), '用量卡片取数完成')
    check(/\d/.test(query('usage-strip')?.querySelector('.v3-home-usage-num')?.textContent ?? ''), '用量卡片显示数字而不是占位')

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

    const usageRange = (label) =>
      [...document.querySelectorAll('[data-usage-control="range"] [role="radio"], [data-usage-control="range"] button')]
        .find((el) => (el.textContent ?? '').trim() === label)
    const clickUsageRange = async (label) => {
      const tab = usageRange(label)
      tab?.click()
      if (!tab) return false
      return until(() => tab.getAttribute('aria-pressed') === 'true' || tab.getAttribute('aria-checked') === 'true', 4000)
    }
    query('v3-home-usage-details')?.click()
    check(await until(() => !!query('usage-details'), 6000), '「查看详情」进入用量页')
    check(await until(() => (query('usage-page-tokens')?.textContent ?? '').includes('8,000'), 6000), '用量页主数字显示 8,000（all）')
    check(!!query('v3-usage-breakdown'), '用量页有分维度的用量明细')
    check(await clickUsageRange('7 天'), '点「7 天」范围切换选中')
    check(await until(() => (query('usage-page-tokens')?.textContent ?? '').includes('5,000'), 5000), '7 天主数字 5,000（只子代理）')
    check(await clickUsageRange('30 天'), '点「30 天」范围切换选中')
    check(await until(() => (query('usage-page-tokens')?.textContent ?? '').includes('8,000'), 5000), '30 天主数字回到 8,000')
    check(await clickUsageRange('全部'), '点「全部」范围切回')
    check(document.querySelectorAll('[data-testid="v3-usage-breakdown"] .usage-page-row[role="row"]').length > 1, '用量明细列出至少一条模型行')
    query('v3-back')?.click()
    check(await until(() => !!query('v3-empty') && !query('usage-details'), 5000), '从用量页返回对话')

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

    out.push('')
    out.push('--- 排队行与模型菜单 ---')
    const queueBefore = store.getState().queue
    store.setState({ queue: { steering: [], followUp: [{ id: 'v3-fixture-queue-1', text: '隔离夹具：排队中的消息' }] } })
    check(await until(() => query('queue-stack')?.dataset.count === '1'), '队列项渲染成一行')
    check(await until(() => query('queue-actions')), '队列项有操作菜单')
    check(await until(() => !!query('queue-edit-start')), '队列行有编辑入口')
    query('queue-edit-start')?.click()
    check(await until(() => !!query('queue-edit-input')), '队列行内编辑框可打开')
    check(query('queue-edit-input')?.value === '隔离夹具：排队中的消息', '编辑框预填队列文本')
    query('queue-edit-cancel')?.click()
    check(await until(() => !query('queue-edit-input')), '队列编辑可取消')
    store.setState({ queue: queueBefore })
    document.querySelector('[data-chat-provider-model-picker]')?.click()
    check(await until(() => document.querySelectorAll('.t3-model-row__name').length > 0, 5000), '模型菜单列出可选的模型行')
    check(!/[¥$]\s?\d/.test(document.querySelector('.t3-model-picker')?.textContent ?? ''), '模型菜单不显示价格')
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await until(() => !document.querySelector('.t3-model-picker'), 3000)
    check(!document.querySelector('.t3-model-picker'), 'Esc 关闭模型菜单')

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
        ['4', 'S12·4', '整理截图证据清单', { kind: 'stalled', since: now - 25_000, cause: 'retry' }],
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
      await wait(9000)
    }
    await wait(50)
    if (query('rp-hide')) await hideRightPanel()
    await wait(100)
    check(
      !document.querySelector('[data-testid="terminal-pane"]') &&
        !document.querySelector('.term-pane') &&
        !document.querySelector('[data-testid="terminal-host"]'),
      '场景结束前 DOM 未挂载任何终端面板'
    )
    const endTerminals = await window.yan.terminal.list().catch(() => null)
    check(Array.isArray(endTerminals) && endTerminals.length === 0, '场景结束前宿主终端表为空，没有隐式创建真实 PTY')
    check(store.getState().browserState?.open === browserBefore, '场景结束前没有隐式打开原生网页')
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
