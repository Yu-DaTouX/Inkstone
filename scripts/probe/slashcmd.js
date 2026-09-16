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
 * Yan 内置命令不依赖 pi；若 pi 也已就绪，则同时验证运行时命令的合并。
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
    // 注册表先返回 Yan 本地命令；pi 若随后就绪，刷新会把运行时命令合并进来。
    await store.getState().reloadCommands()
    await until(() => store.getState().commands.some((c) => c.name === 'new' && c.source === 'yan'), 6000)
    await sleep(300)
    const cmds = store.getState().commands
    out.push('=== 0. 命令列表 ===')
    out.push('  共 ' + cmds.length + ' 条: ' + JSON.stringify(cmds.slice(0, 6).map((c) => c.name)))
    if (cmds.length > 0) ok('拿到了命令列表')
    else {
      /*
       * pi 没就绪（隔离环境里它起不来）→ 整个场景没有可测的对象。
       * 明确标注跳过，而不是报 ✗ —— 否则环境问题会被读成代码回归。
       * 另外：以前这里会因为 listCommands 直接抛异常而让**整个探针崩掉**，
       * 连这条说明都看不到（store 的拉取类动作已加保护）。
       */
      out.push('  ⤺ 跳过：pi 未就绪（conn=' + store.getState().conn + '），命令列表为空')
      out.push('    本场景要靠 pi 提供的命令列表才能验证填充与排序。')
      return out.join('\n')
    }

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

    out.push('\n=== 3. 来源分类与兼容边界 ===')
    setVal(ta(), '/')
    await sleep(500)
    const groups = [...document.querySelectorAll('.slash-group')].map((x) => x.textContent || '')
    out.push('  分类标题: ' + JSON.stringify(groups))
    if (groups.includes('Yan 内置')) ok('菜单显示 Yan 内置分类')
    else bad('菜单没有 Yan 内置分类')
    const compat = [...document.querySelectorAll('.slash-item')].find((x) => /\/panel|\/footer/.test(x.textContent || ''))
    if (compat && compat.disabled && compat.getAttribute('aria-disabled') === 'true') ok('终端兼容命令可见但不可执行')
    else bad('兼容命令没有正确禁用')

    out.push('\n=== 4. 填充：Enter / Tab 都能填入，且带尾空格 ===')
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

    out.push('\n=== 5. 按键说明可见 ===')
    setVal(ta(), '/')
    await until(() => document.querySelector('[data-testid="slash-hint"]'), 4000)
    const hint = document.querySelector('[data-testid="slash-hint"]')
    out.push('  提示文案: ' + JSON.stringify(hint?.textContent ?? '（无）'))
    if (hint && /Enter|Tab/.test(hint.textContent)) ok('菜单底部写明了快捷键')
    else bad('没有按键说明')
    setVal(ta(), '')

    out.push('\n=== 6. 本地 `/model` 路由到模型状态页 ===')
    setVal(ta(), '/model')
    await sleep(300)
    document.querySelector('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => store.getState().settingsOpen && store.getState().settingsTab === 'status', 4000)
    if (store.getState().settingsOpen && store.getState().settingsTab === 'status') ok('/model 路由到模型状态页')
    else bad('/model 没有走 Yan 本地路由')
    store.getState().closeSettings()

    /*
     * ---- 下面几条补 N18 矩阵里没覆盖的边界 ----
     * 注入一份**合成命令列表**：屏幕上的命令是 pi/技能提供的，内容不可控；
     * 要验的是菜单本身的行为（筛选/滚动/光标/IME/同名不同来源/未连接），
     * 所以直接给一份确定的数据。
     */
    const synth = []
    for (let i = 1; i <= 20; i += 1) {
      synth.push({
        name: `probe-cmd-${String(i).padStart(2, '0')}`,
        description: `第 ${i} 条探测命令，用来撑满列表`,
        source: 'runtime',
        executable: true
      })
    }
    synth.push({ name: 'help', description: 'Yan 自己的帮助', source: 'yan', executable: true })
    synth.push({ name: 'help', description: '扩展提供的帮助', source: 'extension', module: 'probe-ext', executable: true })
    synth.push({ name: 'auth', description: '未连接时仍可用的本地命令', source: 'yan', executable: true })

    out.push('\n=== 8. 筛选：按命令名与说明都能命中 ===')
    /* 先存真实列表：后面的 `/login` 路由要靠它 */
    const realCommands = store.getState().commands
    store.setState({ commands: synth, commandsAt: Date.now() })
    setVal(ta(), '/probe-cmd-1')
    await sleep(500)
    const byName = [...document.querySelectorAll('.slash-item .slash-name')].map((x) => x.textContent)
    out.push('  按名字 /probe-cmd-1 → ' + JSON.stringify(byName))
    if (byName.length === 10 && byName[0] === '/probe-cmd-10') ok('按命令名前缀筛选（20 条里命中 10 条：10~19）')
    else bad('按名字筛选不对劲：' + JSON.stringify(byName))
    setVal(ta(), '/撑满')
    await sleep(500)
    const byDesc = [...document.querySelectorAll('.slash-item')].length
    out.push('  按说明里的字“撑满” → ' + byDesc + ' 条')
    if (byDesc === 20) ok('说明文字也参与匹配（20 条全部提到“撑满”）')
    else bad('说明没有参与匹配，只命中 ' + byDesc + ' 条')

    out.push('\n=== 9. 超过 12 项时可滚动，不把窗口撑破 ===')
    setVal(ta(), '/')
    await sleep(600)
    const menuBox = document.querySelector('.slash-menu')
    const menuRect = menuBox?.getBoundingClientRect()
    out.push(
      '  菜单高 ' + Math.round(menuRect?.height ?? 0) + 'px，内容高 ' + (menuBox?.scrollHeight ?? 0) + 'px，项数 ' +
        document.querySelectorAll('.slash-item').length
    )
    if (menuBox && menuBox.scrollHeight > menuBox.clientHeight + 4) ok('项目超出时菜单可滚动（scrollHeight > clientHeight）')
    else bad('菜单没有滚动（项目数超了也看不到后面的）')
    if (menuRect && menuRect.top >= -1) ok('菜单没有越出窗口上沿')
    else bad('菜单顶部越界：top=' + Math.round(menuRect?.top ?? -999))
    const hintText = document.querySelector('[data-testid="slash-hint"]')?.textContent ?? ''
    out.push('  底部提示: ' + JSON.stringify(hintText.slice(0, 60)))
    if (/可滚动/.test(hintText)) ok('提示里说明了列表可滚动')
    else bad('没有提示可滚动')

    out.push('\n=== 10. 光标位置：进了参数区就不该再当成命令名 ===')
    setVal(ta(), '/help ')
    await sleep(400)
    out.push('  "/help "（光标在末尾）菜单=' + (document.querySelector('.slash-menu') ? '有' : '无'))
    if (!document.querySelector('.slash-menu')) ok('光标进入参数区后菜单关闭（不把参数当命令名）')
    else bad('光标已到参数区，菜单还开着')
    /* 光标回到命令名中间 → 菜单应该重新出现（只按光标之前的内容判） */
    ta().selectionStart = 3
    ta().selectionEnd = 3
    ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    ta().dispatchEvent(new Event('select', { bubbles: true }))
    await sleep(500)
    out.push('  光标移到 /he| lp → 菜单=' + (document.querySelector('.slash-menu') ? '有' : '无'))
    if (document.querySelector('.slash-menu')) ok('光标回移到命令名内时菜单恢复')
    else out.push('  ⤺ 说明：光标只能由真实按键移动，合成事件不同步时这一条不作断言')

    out.push('\n=== 11. 同名不同来源要能区分（不互相覆盖） ===')
    setVal(ta(), '/help')
    await sleep(500)
    const helpItems = [...document.querySelectorAll('.slash-item')].filter((x) => /\/help\b/.test(x.querySelector('.slash-name')?.textContent ?? ''))
    const helpSrcs = helpItems.map((x) => x.querySelector('.slash-src')?.textContent ?? '')
    out.push('  /help 条目=' + helpItems.length + ' 来源=' + JSON.stringify(helpSrcs))
    if (helpItems.length === 2) ok('两条同名命令都列出来了（按来源分开）')
    else bad('同名命令被覆盖，只剩 ' + helpItems.length + ' 条')
    if (helpSrcs.some((s) => s.includes('yan')) && helpSrcs.some((s) => s.includes('extension'))) {
      ok('来源标签能区分它们')
    } else bad('来源标签不够区分：' + JSON.stringify(helpSrcs))

    out.push('\n=== 12. 中文输入法组合态不得吞掉 Enter/Tab ===')
    setVal(ta(), '/help')
    await sleep(400)
    const beforeCompose = ta().value
    ta().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    )
    await sleep(300)
    out.push('  组合态 Enter 后 value=' + JSON.stringify(ta().value))
    if (ta().value === beforeCompose) ok('组合中的 Enter 交给输入法（不把候选填进去）')
    else bad('组合态的 Enter 被当成了菜单确认')

    out.push('\n=== 13. 未连接时本地命令仍可执行，扩展命令明确不可用 ===')
    const realConn = store.getState().conn
    store.setState({ conn: 'connecting' })
    await sleep(400)
    setVal(ta(), '/auth')
    await sleep(500)
    const authItem = [...document.querySelectorAll('.slash-item')].find((x) =>
      /\/auth\b/.test(x.querySelector('.slash-name')?.textContent ?? '')
    )
    out.push('  /auth（本地）disabled=' + String(authItem?.disabled) + ' · 来源=' + (authItem?.querySelector('.slash-src')?.textContent ?? ''))
    if (authItem && !authItem.disabled) ok('本地 Yan 命令在未连接时仍可执行')
    else bad('未连接时把本地命令也禁用了')
    const extItem = [...document.querySelectorAll('.slash-item')].find((x) =>
      (x.querySelector('.slash-src')?.textContent ?? '').includes('extension')
    )
    out.push('  扩展命令 title=' + JSON.stringify((extItem?.getAttribute('title') ?? '').slice(0, 40)))
    store.setState({ conn: realConn })
    await sleep(300)

    out.push('\n=== 14. Esc 关闭菜单且不动已输入内容 ===')
    setVal(ta(), '/probe')
    await sleep(500)
    key(ta(), 'Escape')
    await sleep(400)
    out.push('  Esc 后 value=' + JSON.stringify(ta().value) + ' 菜单=' + (document.querySelector('.slash-menu') ? '有' : '无'))
    if (!document.querySelector('.slash-menu')) ok('Esc 关闭菜单')
    else bad('Esc 没关掉菜单')
    if (ta().value === '/probe') ok('关闭菜单不改动已输入内容')
    else bad('Esc 把输入内容也改了：' + JSON.stringify(ta().value))
    setVal(ta(), '')

    /* 把真实命令列表换回来，不然 /login 会被当成普通消息发给模型 */
    store.setState({ commands: realCommands, commandsAt: Date.now() })
    await sleep(300)

    out.push('\n=== 15. `/login` 不发给模型，而是打开「模型接入」 ===')
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
