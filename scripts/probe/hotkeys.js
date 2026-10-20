;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const skip = (s) => out.push('  ⤺ 跳过：' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  out.push('=== 0. 主进程 → 渲染端的快捷键通道 ===')
  ok(typeof window.yan.onHotkey === 'function', 'bridge 上暴露了 onHotkey')

  const seen = []
  window.yan.onHotkey((a) => seen.push(a))

  const toasts = []
  const collectToasts = () => {
    for (const el of document.querySelectorAll('.ui-toast__title')) {
      const text = el.textContent ?? ''
      if (text && !toasts.includes(text)) toasts.push(text)
    }
  }
  const toastWatch = new MutationObserver(collectToasts)
  toastWatch.observe(document.body, { childList: true, subtree: true, characterData: true })

  const ta = document.querySelector('[data-testid="composer-input"]')
  window.__yanComposer.focus(ta)
  out.push('  焦点: ' + (document.activeElement?.tagName ?? '-'))

  out.push('')
  out.push('=== 1. 真实按键（已由主进程在探针前发出）===')
  await sleep(5500)
  out.push('  收到的动作: ' + JSON.stringify(seen))
  ok(seen.length > 0, '主进程拦到了按键并转成动作')
  ok(seen.includes('cycleModelBack'), 'Ctrl+Shift+P 转成 cycleModelBack（上一个模型）')

  out.push('')
  out.push('=== 2. 动作生效 ===')
  const st = store.getState()
  const s = st.session
  const piReady = st.conn === 'ready' && st.models.length > 0
  out.push(
    `  conn=${st.conn} 模型数=${st.models.length} 当前模型=${s?.model?.name ?? '-'} 强度=${s?.thinkingLevel ?? '-'}`
  )
  if (piReady) {
    ok(!!s?.model?.name, '会话有模型（说明 state 正常）')
    collectToasts()
    toastWatch.disconnect()
    out.push('  提示: ' + JSON.stringify(toasts))
    ok(
      toasts.some((t) => t.startsWith('模型 →') || t.includes('思考') || t.includes('模型')),
      '按下去有可见反馈（提示条）'
    )
  } else {
    skip(`pi 未就绪（conn=${st.conn}、模型 ${st.models.length} 个），模型切换与提示条的断言无法验证`)
    out.push('  pi 日志尾部: ' + JSON.stringify(st.logs.slice(-3)))
    out.push('  连接详情: ' + JSON.stringify(st.connDetail ?? ''))
  }

  out.push('')
  out.push('=== 3. 不干扰输入 ===')
  if (!ta) {
    ok(false, '找不到 [data-testid="composer-input"]（输入区没渲染出来）')
    out.push(
      `  诊断: .composer=${document.querySelectorAll('.composer').length} 个, ` +
        `composer-input=${document.querySelectorAll('[data-testid="composer-input"]').length} 个, ` +
        `body 子节点=${document.body.children.length} 个`
    )
  } else {
    ok(true, '输入框还在（contenteditable 宿主）')
    ok(ta.isContentEditable, '输入框可编辑（contenteditable）')
    if (piReady) {
      ok(document.activeElement === ta, 'focus() 能落到输入框（没被别的元素抢走）')
    } else {
      skip(`pi 未就绪（conn=${st.conn}）→ 不校验焦点是否被提示层抢走`)
    }
  }

  out.push('')
  out.push('=== 4. 循环范围与界面一致 ===')
  const models = st.models
  const cur = store.getState().session?.model
  const inList = models.some((m) => m.provider === cur?.provider && m.id === cur?.id)
  out.push(`  模型总数: ${models.length}`)
  if (models.length === 0) skip('模型列表为空（pi 未就绪），无法校验循环范围')
  else ok(inList || !cur, `切到的模型在界面列表里（${cur?.name ?? '-'}）`)

  return out.join('\n')
})()
