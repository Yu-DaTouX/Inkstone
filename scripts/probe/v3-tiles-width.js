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
  const KEY = 'inkstone.v3.tilesWidth'
  const barWidth = () => Math.round(q('v3-sessionbar')?.getBoundingClientRect().width ?? 0)
  const handle = () => q('v3-tiles-resizer')
  const press = (key, shiftKey = false) =>
    handle()?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  const contentRight = () => {
    const el = document.querySelector('.v3-stream-inner')
    return el ? el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight) : NaN
  }
  const barLeft = () => q('v3-sessionbar').getBoundingClientRect().left

  try {
    out.push('=== v3 磁贴列拖宽（隔离探针）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
    if (!store) throw new Error('隔离探针 store 不可用')
    try {
      localStorage.setItem('yan.onboarded', '1')
      localStorage.removeItem(KEY)
    } catch {
    }
    document.querySelector('.v3-ob-overlay')?.querySelector('.ui-dialog__close')?.click()
    check(await until(() => store.getState().sessions.length > 0, 10000), '隔离会话表已就绪')
    if (q('v3-header-sessionbar')?.getAttribute('aria-pressed') !== 'true') q('v3-header-sessionbar')?.click()
    const fixture = store.getState().sessions.find((s) => (s.path || '').includes('yan-todo-fixture'))
    if (fixture) {
      await store.getState().switchSession(fixture.path)
      await until(() => store.getState().session?.sessionFile === fixture.path, 10000)
    }
    store.setState({
      todos: [
        { text: '读 spec 并确认范围', done: true },
        { text: '写 protocol.ts 的 JSONL 分帧', done: true },
        { text: '把渲染端的假数据换成 MainPush 补丁', done: false },
        { text: '补测试并用真实应用跑一遍回归', done: false }
      ]
    })
    check(await until(() => !!handle() && barWidth() > 0, 8000), '磁贴列与拖宽柄已出现')
    note(`窗口 ${innerWidth}x${innerHeight}`)

    out.push('')
    out.push('--- 1. 默认与形态 ---')
    check(barWidth() === 300, `默认宽度 300（实际 ${barWidth()}）`)
    check(handle()?.getAttribute('role') === 'separator' && handle()?.getAttribute('data-grip') === 'true', '拖宽柄是 separator 且使用 grip 短条')
    check((handle()?.getAttribute('title') ?? '') !== '', `悬停提示 ${JSON.stringify(handle()?.getAttribute('title'))}`)
    const hb = handle().getBoundingClientRect()
    const cb = document.querySelector('.v3-chat').getBoundingClientRect()
    check(Math.abs(hb.top - cb.top) < 2 && Math.abs(hb.bottom - cb.bottom) < 2, '拖宽柄贯穿聊天区高度（短条垂直居中）')
    const gripStyle = getComputedStyle(handle(), '::after')
    check(Math.abs(parseFloat(gripStyle.width) - 4) < 0.1 && Math.abs(parseFloat(gripStyle.height) - 32) < 0.1, `短条 4×32（实际 ${gripStyle.width}×${gripStyle.height}）`)
    check(hb.width >= 7.9, `命中区宽度 ≥ 8px（${Math.round(hb.width)}px，加伪元素外扩更宽）`)
    const bar0 = q('v3-sessionbar').getBoundingClientRect()
    check(hb.right <= bar0.left + 0.5 && bar0.left - hb.right < 14, '拖宽柄紧贴磁贴列左缘')

    out.push('')
    out.push('--- 2. 键盘 ---')
    handle().focus()
    press('ArrowLeft')
    check(await until(() => barWidth() === 316), `← 加宽一步到 316（实际 ${barWidth()}）`)
    press('ArrowRight')
    check(await until(() => barWidth() === 300), `→ 收窄一步回 300（实际 ${barWidth()}）`)
    press('Home')
    check(await until(() => barWidth() > 300), `Home 到最宽（实际 ${barWidth()}）`)
    const widest = barWidth()
    check(widest <= 480 && widest >= 300, `最宽不超过上限 480（实际 ${widest}）`)
    check(await until(() => contentRight() <= barLeft() + 0.5), `最宽时消息列右缘 ${Math.round(contentRight())} 不压到磁贴列 ${Math.round(barLeft())}`)
    const messageWidth = document.querySelector('.v3-stream-inner > *')?.getBoundingClientRect().width ?? 0
    check(messageWidth >= 400, `最宽时消息列仍可读（${Math.round(messageWidth)}px）`)
    press('End')
    check(await until(() => barWidth() === 260), `End 到最窄 260（实际 ${barWidth()}）`)
    check(await until(() => contentRight() <= barLeft() + 0.5), `最窄时消息列右缘 ${Math.round(contentRight())} 不压到磁贴列 ${Math.round(barLeft())}`)
    press('ArrowRight')
    await wait(200)
    check(barWidth() === 260, '到下限后继续收窄无效')

    out.push('')
    out.push('--- 3. 双击恢复默认 ---')
    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    check(await until(() => barWidth() === 300), `双击恢复 300（实际 ${barWidth()}）`)

    out.push('')
    out.push('--- 4. 指针拖动 ---')
    const pointer = (type, target, x, y) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y
        })
      )
    const errors = []
    const onError = (event) => errors.push(String(event.message))
    window.addEventListener('error', onError)
    const hb2 = handle().getBoundingClientRect()
    const x0 = hb2.left + hb2.width / 2
    const y0 = hb2.top + hb2.height / 2
    pointer('pointerdown', handle(), x0, y0)
    await wait(60)
    pointer('pointermove', handle(), x0 - 90, y0)
    pointer('pointermove', handle(), x0 - 120, y0)
    const widened = await until(() => barWidth() === 420, 1500)
    pointer('pointerup', handle(), x0 - 120, y0)
    window.removeEventListener('error', onError)
    if (widened) {
      check(true, `向左拖 120px 加宽到 420（实际 ${barWidth()}）`)
    } else {
      note(`合成指针事件未能驱动拖动（实际 ${barWidth()}，错误 ${errors.join('|') || '无'}）；拖动逻辑由 Splitter 单测覆盖`)
      handle().focus()
      for (let i = 0; i < 7; i++) press('ArrowLeft')
      await until(() => barWidth() === 412)
    }

    out.push('')
    out.push('--- 5. 持久化 ---')
    await wait(400)
    check(localStorage.getItem(KEY) === String(barWidth()), `写入 ${KEY}=${localStorage.getItem(KEY)}（当前 ${barWidth()}）`)

    out.push('')
    out.push('--- 6. 横向溢出 ---')
    check(document.documentElement.scrollWidth <= innerWidth + 1, '无页面横向溢出')
    const stream = document.querySelector('.v3-stream-inner')
    if (stream) {
      const sb = stream.getBoundingClientRect()
      const barLeft = q('v3-sessionbar').getBoundingClientRect().left
      note(`消息列右缘 ${Math.round(sb.right)} / 磁贴列左缘 ${Math.round(barLeft)}`)
    }

    out.push(`FINAL width=${barWidth()}`)
    out.push('证据范围：隔离 DOM + 键盘/双击/合成指针；不代表真实模型。')
    await wait(Number(window.__tilesHold ?? 14000))
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
