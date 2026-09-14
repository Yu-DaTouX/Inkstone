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
 *
 * ── ⚠️ 订阅必须放在最前面 ──
 * 曾经是「先轮询等 conn === 'ready'（最多 40s）再订阅」。在 pi 连不上的
 * 环境里轮询会跑满 40s，而按键在探针开始后 1.8s 就发完了 ——
 * seen 永远是空的，于是报出「主进程没拦到按键」这个**完全错误**的结论
 * （拦是拦到了，只是没人听）。现在先订阅、再等，两件事互不干扰。
 *
 * ── 依赖 pi 的断言 ──
 * 「模型真的换了」「有提示条」需要 pi 子进程在跑。pi 没连上时这些断言
 * 无法成立，但那不是快捷键坏了 —— 所以降级为「跳过」并明确标注，
 * 而不是报 ✗（否则环境问题会被误读成回归）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const skip = (s) => out.push('  ⤺ 跳过：' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  /* ---- 0. 通道存在 + **立刻**订阅（按键 1.8s 后就来了）---- */
  out.push('=== 0. 主进程 → 渲染端的快捷键通道 ===')
  ok(typeof window.yan.onHotkey === 'function', 'bridge 上暴露了 onHotkey')

  const seen = []
  window.yan.onHotkey((a) => seen.push(a))

  /* 焦点放进输入框 —— 用户实际就是在这里按的 */
  const ta = document.querySelector('.composer textarea')
  ta?.focus()
  out.push('  焦点: ' + (document.activeElement?.tagName ?? '-'))

  /* ---- 1. 等真按键（test-live 在每个组合之间等 1.6s）---- */
  out.push('')
  out.push('=== 1. 真实按键（已由主进程在探针前发出）===')
  await sleep(5500)
  out.push('  收到的动作: ' + JSON.stringify(seen))
  ok(seen.length > 0, '主进程拦到了按键并转成动作')
  ok(seen.includes('cycleModelBack'), 'Ctrl+Shift+P 转成 cycleModelBack（上一个模型）')

  /* ---- 2. 动作真的改了状态（需要 pi 在跑）---- */
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
    const notices = st.notices.map((n) => n.text)
    out.push('  提示: ' + JSON.stringify(notices))
    ok(
      notices.some((t) => t.startsWith('模型 →') || t.includes('思考') || t.includes('模型')),
      '按下去有可见反馈（提示条）'
    )
  } else {
    skip(`pi 未就绪（conn=${st.conn}、模型 ${st.models.length} 个），模型切换与提示条的断言无法验证`)
    out.push('  pi 日志尾部: ' + JSON.stringify(st.logs.slice(-3)))
    out.push('  连接详情: ' + JSON.stringify(st.connDetail ?? ''))
  }

  /* ---- 3. 快捷键不能把按键卡死在输入框 ---- */
  out.push('')
  out.push('=== 3. 不干扰输入 ===')
  if (!ta) {
    bad('找不到 .composer textarea（输入区没渲染出来）')
    out.push(
      `  诊断: .composer=${document.querySelectorAll('.composer').length} 个, ` +
        `textarea=${document.querySelectorAll('textarea').length} 个, ` +
        `body 子节点=${document.body.children.length} 个`
    )
  } else {
    ok(true, '输入框还在（.composer textarea）')
    if (piReady) {
      ok(!ta.disabled, '输入框未被禁用')
      ok(document.activeElement === ta, 'focus() 能落到输入框（没被别的元素抢走）')
    } else {
      /* pi 断了就**应该**禁用输入框，这是正确行为，不是回归 */
      skip(`pi 未就绪 → 输入框按设计禁用（disabled=${ta.disabled}），不校验可用性`)
    }
  }

  /* ---- 4. 模型列表确实在界面上可见（不是切到了列表外的模型）---- */
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
