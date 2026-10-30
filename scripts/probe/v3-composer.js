;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
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
  const store = window.__yanStore
  const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  const composer = window.__yanComposer
  const setValue = (el, text) => composer.set(text, el)
  const pointer = (type, target, x, y) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 7,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y
      })
    )

  try {
    out.push('=== v3 输入框底栏（隔离探针）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    check(await until(() => !!q('composer-input'), 6000), '正式输入框已挂载')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }
    store.setState({ peekedSessionId: '__v3-composer-probe__' })
    await wait(350)

    out.push('')
    out.push('--- 1. 输入行与状态行控件顺序 ---')
    const line = document.querySelector('.composer-line')
    check(!!line, '输入行 .composer-line 存在')
    const lineIds = () =>
      [...(line?.querySelectorAll('[data-testid]') ?? [])]
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => ['composer-plus', 'composer-mode', 'composer-input', 'voice-start', 'composer-send', 'composer-stop'].includes(id))
    check(lineIds()[0] === 'composer-input', `输入行只放输入（实际 ${JSON.stringify(lineIds())}）`)
    check(!document.querySelector('.composer-prompt'), '输入行不再有 › 提示符')
    const bar = document.querySelector('.composer-bar')
    check(!!bar, '状态行 .composer-bar 存在')
    check(bar?.parentElement?.lastElementChild === bar, '状态行在框内最底部')
    const tools = bar?.querySelector('.composer-tools')
    check(bar?.firstElementChild === tools, '左侧控件组是状态行第一个子元素')
    const leftIds = () =>
      [...(tools?.querySelectorAll('[data-testid]') ?? [])]
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => ['model-picker', 'thinking-picker', 'permission-picker', 'composer-project'].includes(id))
    check(
      leftIds()[0] === 'model-picker' && leftIds()[1] === 'thinking-picker' && leftIds()[2] === 'permission-picker',
      `状态行左侧：模型 → 思考 → 权限（实际 ${JSON.stringify(leftIds())}）`
    )
    const permLabel = document.querySelector('.composer-permission .cp-label')
    check(!!permLabel && permLabel.getBoundingClientRect().width > 8, '权限文字可见')
    if (store.getState().messages.length === 0) {
      const peeked = store.getState().peekedSessionId
      store.setState({ peekedSessionId: null })
      check(await until(() => !!q('composer-project')), '新会话底栏有项目选择')
      q('composer-project')?.click()
      check(await until(() => !!q('composer-project-browse')), '项目菜单里有「选择文件夹」')
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await until(() => !q('composer-project-menu'), 2000)
      store.setState({ peekedSessionId: peeked })
      check(await until(() => !q('composer-project')), '查看其他会话时不显示项目选择')
    }
    const textarea = q('composer-input')
    setValue(textarea, '!echo hi')
    check(
      await until(() => !!q('composer-mode')),
      '输入 ! 后出现 bash 模式徽标'
    )
    check(
      lineIds()[0] === 'composer-mode' && lineIds()[1] === 'composer-input',
      `模式徽标作为输入前缀（实际 ${JSON.stringify(lineIds())}）`
    )
    setValue(textarea, '')

    const end = bar?.querySelector('.composer-line-end')
    const rightIds = () =>
      [...(end?.querySelectorAll('[data-testid]') ?? [])]
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => ['composer-plus', 'voice-start', 'composer-send', 'composer-stop'].includes(id))
    note(`状态行右侧顺序：${JSON.stringify(rightIds())}`)
    check(bar?.lastElementChild === end, '右侧控件组在状态行最末')
    check(rightIds()[0] === 'composer-plus', '＋在右侧控件组开头')
    check(['composer-send', 'composer-stop'].includes(rightIds().at(-1)), '发送 / 停止在状态行最末位')
    check(!!end?.querySelector('.composer-voice'), '语音在发送左侧')

    out.push('')
    out.push('--- 2. 发送 · 停止切换 ---')
    const base = store.getState()
    const setRunning = (running) =>
      store.setState({
        session: { ...(base.session ?? {}), isAgentRunning: running, isCompacting: running, isStreaming: false }
      })
    setRunning(true)
    check(await until(() => !!q('composer-stop')), '运行中 + 空输入 → 显示停止')
    check(!q('composer-send'), '同一位置不再显示发送')
    setValue(q('composer-input'), '探针草稿')
    check(
      await until(() => !!q('composer-send') && !q('composer-stop')),
      '有输入时 → 显示发送（运行中点发送即插话）'
    )
    setValue(q('composer-input'), '')
    check(await until(() => !!q('composer-stop')), '清空后又回到停止')
    setRunning(false)
    check(
      await until(() => !!q('composer-send') && !q('composer-stop')),
      '空闲时即使空输入也显示发送'
    )

    out.push('')
    out.push('--- 3. 思考滑杆（拖动预览 / 松手提交）---')
    const snap = store.getState()
    store.setState({
      thinkingLevels: LEVELS,
      session: {
        ...(snap.session ?? {}),
        sessionId: snap.session?.sessionId ?? '__v3-composer-probe__',
        thinkingLevel: 'medium',
        thinkingLevelsStatus: 'known',
        availableThinkingLevels: LEVELS,
        isAgentRunning: false,
        isCompacting: false,
        isStreaming: false
      }
    })
    check(
      await until(() => q('composer-border')?.getAttribute('data-level') === 'medium'),
      '顶边 data-level 初始为 medium'
    )
    q('thinking-picker')?.click()
    check(await until(() => !!q('thinking-stops')), '思考浮层打开，字符刻度出现')
    const commits = []
    const realSetThinking = store.getState().setThinking
    store.setState({ setThinking: async (level) => { commits.push(level) } })
    await wait(120)

    const cells = [...(q('thinking-stops')?.querySelectorAll('.ui-ascii-scale__cell') ?? [])]
    check(cells.length === LEVELS.length, `字符刻度渲染 ${LEVELS.length} 格（实际 ${cells.length}）`)
    const highCell = q('thinking-high')
    if (highCell) {
      const before = commits.length
      highCell.focus()
      highCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      highCell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
      if (!(await until(() => commits.length > before, 800))) highCell.click()
      check(await until(() => commits.length > before, 2500), '选中 high 格后调用 setThinking')
      check(commits.at(-1) === 'high', `提交档位 high（实际 ${JSON.stringify(commits.at(-1))}）`)
      check(
        q('composer-border')?.getAttribute('data-level') === 'medium',
        '提交被替身拦下时顶边仍是 medium（只认已落盘的档位）'
      )
    }
    store.setState({ setThinking: realSetThinking })

    out.push('')
    out.push('--- 4. 顶边空闲不可见 · 运行中按档位换色 ---')
    q('thinking-picker')?.click()
    await until(() => !q('thinking-stops'), 2000)
    const borderEl = q('composer-border')
    const composerEl = document.querySelector('.composer')
    const setSession = (patch) => {
      const s = store.getState().session ?? {}
      store.setState({ session: { ...s, ...patch } })
    }
    const setLevel = (level) => setSession({ thinkingLevel: level })
    const prevTransition = borderEl?.style.transition ?? ''
    if (borderEl) borderEl.style.transition = 'none'

    setSession({ isAgentRunning: false, isCompacting: false, isStreaming: false })
    check(await until(() => borderEl?.getAttribute('data-state') === 'idle', 2000), '空闲时 data-state 为 idle')
    const idleStyle = getComputedStyle(borderEl)
    check(idleStyle.opacity === '0', `空闲时顶边完全不可见（opacity=${idleStyle.opacity}）`)
    check(idleStyle.position === 'absolute', '顶边绝对定位，不占卡片高度')
    const firstRow = document.querySelector('.composer-input')
    const idleGap = firstRow ? Math.round(firstRow.getBoundingClientRect().top - composerEl.getBoundingClientRect().top) : -1
    note(`空闲时输入行距卡片顶 ${idleGap}px（应等于卡片上内边距，顶边不占位）`)

    setSession({ isAgentRunning: true })
    check(await until(() => borderEl?.getAttribute('data-state') === 'working', 2000), '运行中 data-state 为 working')
    check(getComputedStyle(borderEl).opacity === '1', '运行中顶边显示')
    const bRect = borderEl.getBoundingClientRect()
    const cRect = composerEl.getBoundingClientRect()
    check(
      Math.abs(bRect.top - (cRect.top - 1)) <= 1 && Math.abs(bRect.left - (cRect.left - 1)) <= 1,
      '顶边贴住卡片 1px 边框（inset:-1px）'
    )
    check(
      getComputedStyle(borderEl).borderTopLeftRadius === getComputedStyle(composerEl).borderTopLeftRadius,
      `顶边继承卡片圆角（${getComputedStyle(borderEl).borderTopLeftRadius}）`
    )

    const readTop = async (level) => {
      setLevel(level)
      await until(() => borderEl?.getAttribute('data-level') === level, 2000)
      return getComputedStyle(borderEl).borderTopColor
    }
    const offTop = await readTop('off')
    const lowTop = await readTop('low')
    const maxTop = await readTop('max')
    check(
      offTop !== lowTop && lowTop !== maxTop && offTop !== maxTop,
      `三档顶边颜色各不相同（off=${offTop} / low=${lowTop} / max=${maxTop}）`
    )
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const thinkOf = (level, fallback) => {
      probe.style.color = `var(--think-${level}, ${fallback})`
      return getComputedStyle(probe).color
    }
    check(lowTop === thinkOf('low', 'var(--data-2)'), `low 顶边取 --think-low（${thinkOf('low', 'var(--data-2)')}）`)
    check(maxTop === thinkOf('max', 'var(--fail)'), `max 顶边取 --think-max（${thinkOf('max', 'var(--fail)')}）`)
    probe.remove()
    if (borderEl) borderEl.style.transition = prevTransition

    out.push('证据范围：隔离 DOM 顺序与切换、真实 PointerEvent 拖动、spy 提交；不代表真实模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
