/**
 * 全局快捷键：Ctrl+P 下一模型 / Ctrl+Shift+P 上一模型 / Shift+Tab 换强度。
 *
 * ── 为什么这个场景必须用真实按键 ──
 * 快捷键是由**主进程**用 `before-input-event` 拦下来的（不是渲染端的
 * window keydown —— 那条路会被输入法组合态、焦点不在 webContents、
 * 菜单 accelerator 吃掉，实测会漏）。
 *
 * 所以从渲染端 `dispatchEvent(new KeyboardEvent(...))` 测这个功能是**无效**的：
 * 它走不到主进程那个钩子。这个场景靠 test-live.mjs 传的
 * `YAN_PROBE_KEYS`（主进程用 `webContents.sendInputEvent` 发的真按键）
 * 触发，脚本本身只负责看结果。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }

  /* ---- 0. 通道存在 ---- */
  out.push('=== 0. 主进程 → 渲染端的快捷键通道 ===')
  ok(typeof window.yan.onHotkey === 'function', 'bridge 上暴露了 onHotkey')

  /* ---- 1. 收集后续动作 ---- */
  out.push('')
  out.push('=== 1. 真实按键（已由主进程在探针前发出）===')
  const seen = []
  window.yan.onHotkey((a) => seen.push(a))

  // 焦点放进输入框 —— 用户实际就是在这里按的
  const ta = document.querySelector('.composer textarea')
  ta?.focus()
  out.push('  焦点: ' + (document.activeElement?.tagName ?? '-'))

  // 等后面的按键（test-live 在每个组合之间等 1.6s）
  await sleep(5500)

  out.push('  收到的动作: ' + JSON.stringify(seen))
  ok(seen.length > 0, '主进程拦到了按键并转成动作')
  ok(seen.includes('cycleModelBack'), 'Ctrl+Shift+P 转成 cycleModelBack（上一个模型）')

  /* ---- 2. 动作真的改了状态 ---- */
  out.push('')
  out.push('=== 2. 动作生效 ===')
  const s = store.getState().session
  out.push('  当前模型: ' + (s?.model?.name ?? '-'))
  out.push('  当前强度: ' + (s?.thinkingLevel ?? '-'))
  ok(!!s?.model?.name, '会话有模型（说明 state 正常）')

  const notices = store.getState().notices.map((n) => n.text)
  out.push('  提示: ' + JSON.stringify(notices))
  ok(
    notices.some((t) => t.startsWith('模型 →') || t.includes('思考') || t.includes('模型')),
    '按下去有可见反馈（提示条）'
  )

  /* ---- 3. 快捷键不能把按键卡死在输入框 ---- */
  out.push('')
  out.push('=== 3. 不干扰输入 ===')
  ok(!!ta, '输入框还在')
  ok(ta && !ta.disabled, '输入框未被禁用')

  /* ---- 4. 模型列表确实在界面上可见（不是切到了列表外的模型）---- */
  out.push('')
  out.push('=== 4. 循环范围与界面一致 ===')
  const models = store.getState().models
  const cur = store.getState().session?.model
  const inList = models.some((m) => m.provider === cur?.provider && m.id === cur?.id)
  out.push(`  模型总数: ${models.length}`)
  ok(inList || !cur, `切到的模型在界面列表里（${cur?.name ?? '-'}）`)

  return out.join('\n')
})()
