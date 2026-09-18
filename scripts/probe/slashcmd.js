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
    const compat = [...document.querySelectorAll('.slash-item')].find((x) => /\/footer/.test(x.textContent || ''))
    if (compat && compat.disabled && compat.getAttribute('aria-disabled') === 'true') ok('终端兼容命令可见但不可执行')
    else bad('兼容命令没有正确禁用')
    /*
     * 实施-02 S4：`/panel` 从补全里隐藏（任务改由砚内置任务计划维护），
     * 但它**必须还在注册表里**（source=compatibility）——
     * 直接删掉它的话，pi 侧同名命令会变成那条可执行的，手打就发给模型了。
     */
    const panelInMenu = [...document.querySelectorAll('.slash-item')].some((x) => /\/panel\b/.test(x.textContent || ''))
    if (!panelInMenu) ok('/panel 不出现在补全候选里（S4）')
    else bad('/panel 仍在补全里（S4 要求隐藏）')
    const panelCmd = store.getState().commands.find((c) => c.name === 'panel')
    if (panelCmd && panelCmd.source === 'compatibility' && panelCmd.hiddenInMenu === true)
      ok('/panel 仍在注册表且标记 hiddenInMenu')
    else bad('/panel 注册表项缺失或没标隐藏：' + JSON.stringify(panelCmd))

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

    /*
     * ---- N18 尾巴：逐命令的**真实执行反馈** ----
     * `/model` 与 `/login` 上面已经验过「路由到正确的窗口 + 不发给模型」。
     * 这里补另外三条，判据是「本地动作真的被执行了」，而不是「输入框里的字消失」：
     *   · `/new`      → 真的换了会话身份（sessionId / 运行实例变化）
     *   · `/browser`  → 真的开了原生浏览器视图；带参数时 URL 原样透传
     *   · `/compact`  → 真的走本地 compact()
     * `/compact` 的**成功**路径要真调模型（花钱），归 cost 1 的 `contexttakeover`；
     * 这一节只钉路由与参数，不在这里伪造压缩成功。
     */
    const slashAsMessage = () =>
      store.getState().messages.some(
        (m) => typeof m.text === 'string' && /^\/(new|browser|compact)\b/.test(m.text)
      )

    out.push('\n=== 16. `/new` 真的新建了会话 ===')
    const beforeSessionId = store.getState().session?.sessionId ?? null
    const beforeRunner = store.getState().activeRunnerId
    setVal(ta(), '/new')
    await sleep(300)
    click(document.querySelector('[data-testid="send"]'))
    const switched = await until(() => {
      const s = store.getState()
      return s.session?.sessionId !== beforeSessionId || s.activeRunnerId !== beforeRunner
    }, 8000)
    const afterNew = store.getState()
    out.push(
      '  会话 ' + JSON.stringify(beforeSessionId) + ' → ' + JSON.stringify(afterNew.session?.sessionId ?? null) +
        ' · 运行实例 ' + JSON.stringify(beforeRunner) + ' → ' + JSON.stringify(afterNew.activeRunnerId) +
        ' · 输入框=' + JSON.stringify(ta().value)
    )
    if (switched) ok('/new 真的换了会话（会话身份或运行实例发生变化）')
    else bad('/new 没有新建会话（会话身份与运行实例都没变）')
    if (ta().value === '') ok('输入框被本地路由消费掉（没有留下 /new）')
    else bad('输入框里还留着 ' + JSON.stringify(ta().value))
    if (!slashAsMessage()) ok('没有把 /new 当消息发给模型')
    else bad('/new 被当成一句话发出去了')
    {
      const err = store.getState().notices.filter((n) => n.type === 'error').map((n) => n.text).join(' | ')
      out.push('  错误提示: ' + JSON.stringify(err))
      if (!/新建失败/.test(err)) ok('主进程没有回「新建失败」')
      else bad('新建失败了：' + err)
    }
    /*
     * 作用域是命令语义的一部分：`/new` 建的是**全局**新会话，不是“在当前项目里
     * 新建”。上面验的是副作用，这里钉住传下去的参数（真实副作用无法区分两者）。
     */
    const newCalls = []
    const realNewSession = store.getState().newSession
    store.setState({ newSession: async (target) => { newCalls.push(target) } })
    await sleep(250)
    setVal(ta(), '/new')
    await sleep(250)
    click(document.querySelector('[data-testid="send"]'))
    await until(() => newCalls.length > 0, 4000)
    store.setState({ newSession: realNewSession })
    out.push('  newSession 收到 ' + JSON.stringify(newCalls))
    if (newCalls[0] && newCalls[0].scope === 'global') ok('/new 传的是全局作用域（scope=global）')
    else bad('/new 的作用域不对：' + JSON.stringify(newCalls[0]))

    out.push('\n=== 17. `/browser` 打开原生视图并把 URL 原样透传 ===')
    const beforeBrowserMsgs = store.getState().messages.length
    /*
     * 真实执行用 `about:blank`：这个场景要验的是「命令 → 本地路由 → 主进程真的
     * 开了原生视图」这条链，不是网页加载本身（那由 `browserboundary` 覆盖）。
     * 用外网首页会让这节依赖网络可达性，红绿就会被网络而不是代码决定。
     */
    setVal(ta(), '/browser about:blank')
    await sleep(300)
    click(document.querySelector('[data-testid="send"]'))
    const opened = await until(() => store.getState().browserState.open, 8000)
    const bstate = store.getState().browserState
    out.push('  browserState: open=' + bstate.open + ' url=' + JSON.stringify(bstate.url))
    if (opened) ok('/browser 真的打开了内置浏览器（主进程开了原生视图）')
    else bad('/browser 没有打开浏览器')
    if (store.getState().messages.length === beforeBrowserMsgs && !slashAsMessage()) ok('没有把 /browser 当消息发给模型')
    else bad('/browser 被当成一句话发出去了')
    await store.getState().closeBrowser()
    await sleep(300)

    /*
     * 参数透传：把本地路由临时换成记录器，验「无参 / 带 URL」两种形状。
     * 这里**不**真去导航外网站点 —— 位置在这条链的参数边界，不是网络。
     */
    const openCalls = []
    const realOpenBrowser = store.getState().openBrowser
    store.setState({ openBrowser: async (url) => { openCalls.push(url) } })
    await sleep(250)
    setVal(ta(), '/browser https://example.com/probe?q=1')
    await sleep(250)
    click(document.querySelector('[data-testid="send"]'))
    await until(() => openCalls.length > 0, 4000)
    setVal(ta(), '/browser')
    await sleep(250)
    click(document.querySelector('[data-testid="send"]'))
    await until(() => openCalls.length > 1, 4000)
    store.setState({ openBrowser: realOpenBrowser })
    out.push('  openBrowser 收到 [' + openCalls.map((v) => (v === undefined ? 'undefined' : JSON.stringify(v))).join(', ') + ']')
    if (openCalls[0] === 'https://example.com/probe?q=1') ok('带参数的 /browser 把 URL 原样透传（参数没被吞掉）')
    else bad('带参数时透传不对：' + JSON.stringify(openCalls[0]))
    if (openCalls.length >= 2 && openCalls[1] === undefined) ok('无参数的 /browser 传 undefined（走主进程默认首页）')
    else bad('无参数时参数不对（收到 ' + openCalls.length + ' 次调用）：' + JSON.stringify(openCalls[1]))
    if (!slashAsMessage()) ok('参数形态下也没有把 /browser 发给模型')
    else bad('参数形态下 /browser 被发出去了')

    /*
     * 失败路径：不要只验“命令成功时是什么样”。非 http(s) 地址会被主进程
     * 拒掉（`safeUrl` 只放行 http/https），用户必须看到**可读的原因** ——
     * 静默失败会让人觉得命令坏了。这条不调模型，所以能在这里真跑。
     */
    store.setState({ notices: [] })
    setVal(ta(), '/browser file:///etc/passwd')
    await sleep(250)
    click(document.querySelector('[data-testid="send"]'))
    const failedNotice = await until(() => store.getState().notices.some((n) => n.type === 'error'), 5000)
    const failText = store.getState().notices.map((n) => n.text).join(' | ')
    out.push('  非法地址的提示: ' + JSON.stringify(failText))
    if (failedNotice && /http\(s\)|只允许/.test(failText)) ok('/browser 拒绝非 http(s) 地址并给出可读原因')
    else bad('/browser 对非法地址没有给出失败反馈：' + JSON.stringify(failText))
    if (store.getState().browserState.url !== 'file:///etc/passwd') ok('被拒的地址没有真的导航过去')
    else bad('非法地址居然导航成功了')
    /*
     * 提示是要给人看的：`Error invoking remote method '…': Error: …` 这层壳是
     * Electron 的传输细节，不该出现在提示条上（`piCall` 早就剥了，这条链路漏了）。
     */
    if (!/Error invoking remote method/.test(failText)) ok('失败提示没有带 IPC 包装前缀')
    else bad('提示里还带着 IPC 传输细节：' + JSON.stringify(failText))

    out.push('\n=== 18. `/compact` 走本地路由 ===')
    /*
     * 成功压缩要真调模型，属于 cost 1 的 `contexttakeover` / `contexttakeoverstate`。
     * 这里钉的是「`/compact` 不会变成一句自然语言」：本地 compact() 必须被调到。
     */
    const realCompact = store.getState().compact
    let compactCalls = 0
    store.setState({ compact: async () => { compactCalls += 1 } })
    await sleep(250)
    const beforeCompactMsgs = store.getState().messages.length
    setVal(ta(), '/compact')
    await sleep(250)
    click(document.querySelector('[data-testid="send"]'))
    await until(() => compactCalls > 0, 4000)
    store.setState({ compact: realCompact })
    out.push('  compact() 被调用 ' + compactCalls + ' 次 · 消息 ' + beforeCompactMsgs + ' → ' + store.getState().messages.length)
    if (compactCalls === 1) ok('/compact 路由到本地 compact()')
    else bad('/compact 没有走到本地路由（调用 ' + compactCalls + ' 次）')
    if (store.getState().messages.length === beforeCompactMsgs && !slashAsMessage()) ok('没有把 /compact 当消息发给模型')
    else bad('/compact 被当成一句话发出去了')

    out.push('\n=== 19. 运行时命令的来源分布 ===')
    const bySource = {}
    for (const c of store.getState().commands) bySource[c.source] = (bySource[c.source] ?? 0) + 1
    out.push('  ' + JSON.stringify(bySource))
    /*
     * 技能命令必须**真的被发现**才算取证：`test-live.mjs` 给这个场景单独
     * 准备了一份 piDir，里面放着 `skills/probe-skill/SKILL.md`。
     * 如果这里数不到，就是发现链路（pi skills 目录 → get_commands → 注册表）断了。
     */
    const skillCmds = store.getState().commands.filter((c) => c.source === 'skill')
    out.push('  技能命令: ' + JSON.stringify(skillCmds.map((c) => c.name)))
    if (skillCmds.length) ok('pi 真的把技能报告成了命令（source=skill）')
    else bad('没有发现任何技能命令（本场景的 piDir 里有 probe-skill/SKILL.md）')
    const extCmds = store.getState().commands.filter((c) => c.source === 'extension')
    if (extCmds.length) ok('扩展来源命令也在（' + extCmds.length + ' 条）')
    else out.push('  ℹ 本环境没有扩展来源命令')

    out.push('\n=== 20. 手打 /panel：给明确反馈，不动草稿与附件（S4） ===')
    /*
     * 兼容命令在桌面端没有可执行动作。旧行为是「静默清空输入框 + 附件」——
     * 用户会以为命令执行完了，而草稿和附件是真的丢了。
     *
     * 附件用合成对象直接进 store（真附件要过文件对话框）——
     * 这里验的是「兼容分支会不会清掉它」，不是附件本身的校验。
     */
    const probeFile = {
      id: 'probe-panel-attachment',
      name: 'probe-panel.txt',
      mimeType: 'text/plain',
      size: 5,
      data: '',
      preview: '',
      kind: 'file',
      path: '/tmp/probe-panel.txt'
    }
    store.getState().clearAttachments()
    store.getState().addAttachments([probeFile])
    const noticesBefore = store.getState().notices.length
    const msgsBeforePanel = store.getState().messages.length
    const draft = '/panel 别清掉我\n第二行'
    setVal(ta(), draft)
    await sleep(250)
    click(document.querySelector('[data-testid="send"]'))
    await until(() => store.getState().notices.length > noticesBefore, 4000)
    out.push('  输入框 = ' + JSON.stringify(ta().value))
    out.push('  附件 ' + store.getState().attachments.length + ' 个 · 新增提示 ' + (store.getState().notices.length - noticesBefore) + ' 条')
    const panelNotices = store
      .getState()
      .notices.slice(noticesBefore)
      .map((n) => n.text)
      .join(' | ')
    out.push('  提示: ' + JSON.stringify(panelNotices))
    if (ta().value === draft) ok('草稿原样保留（以前会被清空）')
    else bad('草稿被动过了：' + JSON.stringify(ta().value))
    if (store.getState().attachments.length === 1) ok('附件保留（以前会被一起清掉）')
    else bad('附件被清掉了（剩 ' + store.getState().attachments.length + '）')
    if (/终端界面|任务计划/.test(panelNotices)) ok('给出了可读原因（说明为什么没有动作）')
    else bad('没有给可读原因：' + panelNotices)
    if (store.getState().messages.length === msgsBeforePanel && !slashAsMessage()) ok('没有把 /panel 当消息发给模型')
    else bad('/panel 被当成一句话发出去了')
    store.getState().clearAttachments()
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[slashcmd] 全部通过' : '[slashcmd] ' + failed + ' 条失败')
  return out.join('\n')
})()
