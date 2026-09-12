/**
 * `/` 斜杠命令：自动管理 + 填充。
 *
 * 用户原话：「还要 / 命令功能的自动管理和填充功能」。拆成两件可验证的事：
 *   · 自动管理：列表过期（命令来自运行时加载的扩展/技能，启动那一刻可能
 *     还没就绪）→ 打开菜单时自动重拉；以及用过的命令排前面
 *   · 填充：Enter / Tab 都能填入，且带一个尾空格（方便接着打参数）
 * 另外验了菜单底部的按键说明可见 —— 这些快捷键一直支持，但界面上没写，
 * 用户只会用鼠标点。
 *
 * 需要 pi 已就绪才有命令列表（本场景会等 conn === ready）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const ta = () => document.querySelector('textarea')
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    // 等 pi 连上（命令列表要 pi 就绪才有）
    await until(() => store.getState().conn === 'ready', 20000)
    await store.getState().reloadCommands()
    await sleep(600)
    const cmds = store.getState().commands
    out.push('=== 0. 命令列表 ===')
    out.push('  共 ' + cmds.length + ' 条: ' + JSON.stringify(cmds.slice(0, 6).map((c) => c.name)))
    if (cmds.length > 0) ok('拿到了命令列表')
    else bad('命令列表是空的')

    out.push('\n=== 1. 自动管理：列表过期时会自动重拉 ===')
    // 手工把时间戳改旧 → 打开菜单应触发重拉
    store.setState({ commandsAt: 0, commands: [] })
    await sleep(200)
    setVal(ta(), '/')
    const refetched = await until(() => store.getState().commands.length > 0, 6000)
    out.push('  重拉后 commands=' + store.getState().commands.length + '  commandsAt=' + (store.getState().commandsAt > 0 ? '已更新' : '还是 0'))
    if (refetched && store.getState().commandsAt > 0) ok('打开菜单时发现列表过期 → 自动重拉')
    else bad('没有自动重拉（命令会一直是旧的）')

    out.push('\n=== 2. 常用优先：用过的排前面 ===')
    const names = store.getState().commands.map((c) => c.name)
    // 挑一个**不是**字母序第一的命令
    const target = names.find((n) => n !== [...names].sort()[0]) ?? names[0]
    out.push('  常用之前，前 3 条: ' + JSON.stringify(store.getState().commands.slice(0, 3).map((c) => c.name)))
    store.getState().markCommandUsed(target)
    store.getState().markCommandUsed(target)
    await sleep(500)
    store.setState({ commandsAt: Date.now() })
    setVal(ta(), '/')
    await sleep(600)
    const menu = document.querySelector('.slash-menu')
    const first = menu?.querySelector('.slash-name')?.textContent ?? ''
    out.push('  标记 ' + target + ' 为常用后，菜单第一条 = ' + JSON.stringify(first))
    if (first === '/' + target) ok('用过的命令被排到最前（自动管理生效）')
    else bad('常用排序没生效，第一条是 ' + first)
    if (localStorage.getItem('yan.cmdUse')) ok('使用次数已落盘（localStorage）')
    else bad('使用次数没存')

    out.push('\n=== 3. 填充：Enter / Tab 都能填入，且带尾空格 ===')
    for (const k of ['Enter', 'Tab']) {
      setVal(ta(), '/')
      await sleep(500)
      key(ta(), k)
      await sleep(400)
      const v = ta().value
      out.push('  ' + k + ' → ' + JSON.stringify(v))
      if (/^\/[a-z-]+ $/.test(v)) ok(k + ' 填入命令并留一个空格（方便接着打参数）')
      else bad(k + ' 没填入或格式不对')
    }

    out.push('\n=== 4. 按键说明可见 ===')
    setVal(ta(), '/')
    await until(() => document.querySelector('[data-testid="slash-hint"]'), 4000)
    const hint = document.querySelector('[data-testid="slash-hint"]')
    out.push('  提示文案: ' + JSON.stringify(hint?.textContent ?? '（无）'))
    if (hint && /Enter|Tab/.test(hint.textContent)) ok('菜单底部写明了快捷键')
    else bad('没有按键说明')
    setVal(ta(), '')

    out.push('\n=== 5. `/login` 不发给模型，而是打开「模型接入」 ===')
    const before = store.getState().messages.length
    setVal(ta(), '/login')
    await sleep(300)
    document.querySelector('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => store.getState().settingsOpen, 4000)
    out.push('  settingsOpen=' + store.getState().settingsOpen + ' tab=' + store.getState().settingsTab)
    if (store.getState().settingsOpen && store.getState().settingsTab === 'auth') ok('/login 路由到「模型接入」窗口')
    else bad('/login 没被拦截（可能当成一句话发给了模型）')
    if (store.getState().messages.length === before) ok('没有把 /login 当消息发给模型')
    else bad('消息里多了一条（说明真的发给模型了）')
    store.getState().closeSettings()
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[slashcmd] 全部通过' : '[slashcmd] ' + failed + ' 条失败')
  return out.join('\n')
})()
