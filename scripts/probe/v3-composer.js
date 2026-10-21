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
    out.push('--- 1. 底栏控件顺序 ---')
    const bar = document.querySelector('.composer-bar')
    check(!!bar, '底栏 .composer-bar 存在')
    const tools = bar?.querySelector('.composer-tools')
    check(!!tools, '左侧控件组 .composer-tools 存在')
    check(bar?.firstElementChild === tools, '左侧控件组是底栏第一个子元素')
    const leftIds = () =>
      [...(tools?.querySelectorAll('[data-testid]') ?? [])]
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => ['composer-mode', 'permission-picker', 'composer-plus'].includes(id))
    check(
      JSON.stringify(leftIds()) === JSON.stringify(['permission-picker', 'composer-plus']),
      `默认左侧顺序：权限 → ＋（实际 ${JSON.stringify(leftIds())}）`
    )
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
      JSON.stringify(leftIds()) === JSON.stringify(['composer-mode', 'permission-picker', 'composer-plus']),
      `模式徽标排在最左（实际 ${JSON.stringify(leftIds())}）`
    )
    setValue(textarea, '')

    const rightLabels = () =>
      [...(bar?.children ?? [])]
        .filter((el) => el !== tools)
        .flatMap((el) => (el.matches('.composer-aux') ? [...el.children] : [el]))
        .map((el) => {
          if (el.matches('.composer-voice')) return 'voice'
          if (el.matches('.ctx-ring-wrap')) return 'context'
          if (el.matches('.mtp-wrap')) return 'model'
          if (el.matches('.composer-run')) return 'run'
          if (el.matches('[data-testid="composer-send"]') || el.matches('[data-testid="composer-stop"]')) return 'send'
          return 'other:' + el.className
        })
    const right = rightLabels()
    note(`右侧顺序：${right.join(' → ')}`)
    check(right[0] === 'voice' && right[1] === 'context' && right[2] === 'model', '右侧前三位是 语音 → 上下文 → 模型+思考')
    check(right.at(-1) === 'send', '发送 / 停止在右侧最末位')
    check(!right.includes('run') || right.indexOf('run') === right.length - 2, '运行位（若显示）在模型与发送之间')

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
        isAgentRunning: false,
        isCompacting: false,
        isStreaming: false
      }
    })
    check(
      await until(() => q('composer-border')?.getAttribute('data-level') === 'medium'),
      '顶边 data-level 初始为 medium'
    )
    q('model-picker')?.click()
    check(await until(() => !!q('thinking-stops')), '模型+思考浮层打开，档位滑杆出现')
    const commits = []
    const realSetThinking = store.getState().setThinking
    store.setState({ setThinking: async (level) => { commits.push(level) } })
    await wait(120)

    const thumb = q('thinking-stops')?.querySelector('.ui-slider__thumb')
    const track = q('thinking-stops')?.querySelector('.ui-slider__track')
    check(!!thumb && !!track, '滑杆手柄与轨道已渲染')
    if (thumb && track) {
      const tb = track.getBoundingClientRect()
      const hb = thumb.getBoundingClientRect()
      const startX = hb.left + hb.width / 2
      const startY = hb.top + hb.height / 2
      const delta = tb.width / (LEVELS.length - 1)
      const before = commits.length
      pointer('pointerdown', thumb, startX, startY)
      await wait(60)
      pointer('pointermove', window, startX + delta, startY)
      await wait(200)
      check(commits.length === before, '拖动过程中 setThinking 未被调用（只预览）')
      check(
        q('thinking-current')?.getAttribute('data-level') === 'high',
        `拖动预览头部显示 high（实际 ${q('thinking-current')?.getAttribute('data-level')}）`
      )
      check(
        q('composer-border')?.getAttribute('data-level') === 'medium',
        '拖动期间顶边仍是已提交的 medium（预览未落盘）'
      )
      pointer('pointerup', window, startX + delta, startY)
      check(await until(() => commits.length > before, 2500), '松手后调用 setThinking')
      check(commits.at(-1) === 'high', `提交档位 high（实际 ${JSON.stringify(commits.at(-1))}）`)
    }
    store.setState({ setThinking: realSetThinking })

    out.push('')
    out.push('--- 4. 顶边空闲不可见 · 运行中按档位换色 ---')
    q('model-picker')?.click()
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
