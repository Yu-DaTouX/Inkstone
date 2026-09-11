;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  /** 轮询等条件成立（固定 sleep 在负载高时会不够，见 features.js 的说明） */
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120) }
    return fn()
  }

  const stat = () => ({
    msgs: qa('.msg').length,
    sessions: qa('.rail .srow').length,
    sel: q('.rail .srow.sel')?.querySelector('.srow-name')?.textContent ?? null,
    sessionFile: null
  })

  log('=== 会话切换 ===')
  // 左栏默认收起（自动隐藏）→ 先展开
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 3, clientY: 400, bubbles: true }))
  const opened = await until(() => !document.querySelector('.app').classList.contains('rail-off'))
  log('左栏已展开: ' + opened)
  log('起始: ' + JSON.stringify(stat()))

  const items = qa('.rail .srow')
  if (items.length < 2) return '会话太少，无法测试切换'

  // 找一条不是路径的、有内容的会话（避免切到空会话）
  const target = items.find((i) => {
    const n = i.querySelector('.srow-name')?.textContent ?? ''
    return !n.startsWith('~') && n.length > 4
  }) ?? items[1]

  const targetName = target.querySelector('.srow-name')?.textContent ?? ''
  log('切到: ' + JSON.stringify(targetName))

  click(target)
  await sleep(6000)   // 等 pi 加载那份会话并 hydrate

  const after = stat()
  log('切换后: ' + JSON.stringify(after))
  log('  消息数>0 : ' + (after.msgs > 0 ? '✓ ' + after.msgs + ' 条' : '✗'))
  /**
   * 选中态：不再直接比较左栏文字与切换前文字。
   *
   * 因为标题现在是**每轮次用模型重算**的（用户要求「每次对话标题需要 agent
   * 生成一个新的」）—— 切换会话会触发一次（命中缓存则用缓存值），
   * 生成完会改写左栏那一行的显示名。所以判据是：
   *   ① 有一行处于选中态，且 ② 它属于目标会话（按 path 比对）。
   */
  const selRow = q('.rail .srow.sel')
  const selPath = selRow?.getAttribute('title') ?? ''
  const targetPath = target.getAttribute('title') ?? ''
  log('  选中态更新: ' + (selRow && selPath === targetPath ? '✓' : `✗ 实际=${after.sel} (${selPath})`))
  if (after.sel !== targetName) {
    log(`  （标题已被模型重写：“${targetName}” → “${after.sel}”）`)
  }
  log('  有用户消息: ' + (qa('.msg.user').length > 0 ? '✓' : '✗'))
  log('  有助手消息: ' + (qa('.msg.assistant').length > 0 ? '✓' : '✗'))

  // 连续性带应该显示那条会话的最后一条用户消息
  const cont = q('.continuity')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  log('  连续性带: ' + JSON.stringify(cont.slice(0, 60)))

  log('=== 新建会话 ===')
  const newBtn = q('[data-testid="rail-new"]')
  if (!newBtn) return '找不到「新对话」按钮'
  click(newBtn)
  await sleep(3500)
  const fresh = stat()
  log('新建后: ' + JSON.stringify(fresh))
  log('  消息清空: ' + (fresh.msgs === 0 ? '✓' : '✗ 还有 ' + fresh.msgs + ' 条'))
  log('  空状态显示: ' + (q('.empty-stream') ? '✓' : '✗'))

  log('=== 连接仍然正常 ===')
  log('  ' + (q('.tb-sync')?.textContent ?? '缺失'))
  log('  输入框可用: ' + !q('[data-testid="composer"]').disabled)

  return out.join('\n')
})()
