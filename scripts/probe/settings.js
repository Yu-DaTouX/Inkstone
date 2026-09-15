/**
 * 设置面板 —— 入口、分区、以及「入口不该重复」。
 *
 * ⚠️ 这个场景整体重写过（2026-09-11）。原来它断言的是：
 *   「右栏（.status）已移除」「中间栏 > 1100px」「标题栏有设置按钮」
 * 这三条全部**已经不再是事实**：
 *   · 右栏回来了，但形态变了（常驻多分区状态栏，不是记忆面板）
 *   · 所以中间栏不再是 1100+（右栏占 264px）
 *   · 设置按钮从标题栏搬走了（用户要求：一个信息只在一个地方出现）
 * 断言绑定了当时的布局，布局变了它就失败 —— 这是「过时断言」，不是回归。
 * 现在改成验证**当前的设计意图**。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  log('=== 1. 三栏格局 ===')
  ok(!!q('.rail'), '左栏存在')
  ok(!!q('.center'), '中栏存在')
  ok(!!q('[data-testid="rightpanel"]'), '右栏存在（常驻状态栏，默认展开）')

  const cw = Math.round(q('.center')?.getBoundingClientRect().width ?? 0)
  log('  中间栏宽度: ' + cw)
  ok(cw > 600, `中间栏宽度合理（${cw}px）`)

  log('')
  log('=== 2. 设置的入口：左栏底部（标题栏那个已按用户要求移除）===')
  const railBtn = q('[data-testid="rail-settings"]')
  ok(!!railBtn, '左栏底部有设置入口')
  ok(!qa('.tb-right [title*="设置"], .tb-right [title*="Settings"]').length, '标题栏不再有重复的设置按钮')

  if (railBtn) {
    click(railBtn)
    await sleep(400)
    ok(!!q('.settings'), '点左栏那个能打开设置面板')
    ok(store.getState().settingsOpen, 'store.settingsOpen = true')
  }

  log('')
  log('=== 3. tab 数量 ===')
  const tabs = qa('.settings-tab').map((x) => x.textContent)
  log('  tab: ' + JSON.stringify(tabs))
  ok(tabs.length >= 4, `有 ${tabs.length} 个 tab（含关闭）`)

  log('')
  log('=== 4. 记忆已移除 ===')
  // 设置里不应再有「记忆」tab（记忆功能整体删掉了）
  const memTab = qa('.settings-tab').find((x) => /记忆|Memory/.test(x.textContent))
  ok(!memTab, '设置里没有「记忆」tab')
  ok(!q('.rightpanel .mem-sections'), '右栏里没有记忆面板')
  ok(!q('.review'), '没有记忆审阅条')

  log('')
  log('=== 5. 外观 tab ===')
  const appTab = qa('.settings-tab').find((x) => /外观|Appearance/.test(x.textContent))
  ok(!!appTab, '有「外观」tab')
  if (appTab) {
    click(appTab)
    await sleep(500)
    const body = q('.settings-body')?.textContent ?? ''
    ok(/深色|浅色|Dark|Light/i.test(body), '外观页有主题切换')
    ok(/中文|English|语言/i.test(body), '外观页有语言切换')
    ok(!!q('[data-testid="set-always-on-top"]'), '外观页有窗口置顶开关')
  }

  log('')
  log('=== 5b. 关于 tab：pi 内核管理 ===')
  const aboutTab = qa('.settings-tab').find((x) => /关于|About/.test(x.textContent))
  ok(!!aboutTab, '有「关于」tab')
  if (aboutTab) {
    click(aboutTab)
    await sleep(500)
    const aboutBody = q('.settings-body')?.textContent ?? ''
    ok(/来源|Source/.test(aboutBody), '关于页显示 pi 来源（内置/系统安装）')
    ok(/版本|Version/.test(aboutBody), '关于页显示 pi 版本')
    ok(!!q('[data-testid="pi-redetect"]'), '关于页有「重新检测」按钮')
    const pi = store.getState().piInfo
    ok(!!pi && !!pi.source, 'store.piInfo 带 source', 'source=' + (pi && pi.source))
    ok(!!pi && !!pi.bin, 'store.piInfo 带入口路径')
  }

  log('')
  log('=== 5c. 声音与通知 tab ===')
  const soundTab = qa('.settings-tab').find((x) => /声音与通知|Sound & notifications/.test(x.textContent))
  ok(!!soundTab, '有「声音与通知」tab')
  if (soundTab) {
    click(soundTab)
    await sleep(500)
    ok(!!q('[data-testid="set-sound"]'), '声音页渲染出设置组')
    const sound0 = store.getState().settings?.sound
    ok(!!sound0 && typeof sound0.volume === 'number', 'store.settings 带 sound 配置')
    const enableBtn = q('[data-testid="set-sound-enabled"]')
    ok(!!enableBtn, '有总开关')
    if (enableBtn && sound0) {
      click(enableBtn)
      await sleep(500)
      ok(store.getState().settings?.sound?.enabled === true, '点总开关后 enabled=true（已落盘）')
      ok(!!q('[data-testid="set-sound-event-done"]'), '有「回合完成」事件开关')
      ok(!!q('[data-testid="set-sound-event-question"]'), '有「需要回答」事件开关')
      ok(!!q('[data-testid="set-sound-event-error"]'), '有「出错」事件开关')
      ok(!!q('[data-testid="set-sound-preview-done"]'), '每个事件可试听')
      ok(!!q('[data-testid="set-sound-notify"]'), '有系统通知开关')
      ok(!!q('[data-testid="set-sound-notify-test"]'), '有测试通知按钮')
      const notifyBtn = q('[data-testid="set-sound-notify"]')
      if (notifyBtn) {
        const beforeN = store.getState().settings?.sound?.notifications
        click(notifyBtn)
        await sleep(500)
        ok(store.getState().settings?.sound?.notifications === !beforeN, '通知开关可切换并落盘')
        click(notifyBtn) // 恢复
        await sleep(500)
      }
      let previewOk = true
      try {
        click(q('[data-testid="set-sound-preview-done"]'))
      } catch {
        previewOk = false
      }
      await sleep(120)
      ok(previewOk, '试听按钮可点击（合成音频路径不抛异常）')
      // 改回关闭，避免影响后续断言（也顺带验证可逆）
      click(enableBtn)
      await sleep(500)
      ok(store.getState().settings?.sound?.enabled === false, '再点一次回到关闭')
    }
  }

  log('')
  log('=== 6. 右栏状态栏的分区 ===')
  // 关掉设置看右栏
  store.getState().closeSettings()
  await sleep(400)
  const secs = qa('[data-sec]').map((x) => x.getAttribute('data-sec'))
  log('  右栏分区: ' + JSON.stringify(secs))
  ok(secs.includes('rp-context'), '右栏有「上下文」分区')
  /*
   * 分区清单变过（2026-09-12）：
   *   · 「环境」（pi 版本 / 模型 / 计数 / 工作目录）**已删** —— 那些都有别处：
   *     模型在标题栏、pi 版本在设置→关于、工作目录在文件树根部
   *   · 新增「文件」（项目文件树）与「日志」（从底部搬过来）
   * 所以断言改成验证**当前的分区集合**，不再绑到已删的 rp-env。
   */
  ok(secs.includes('rp-files'), '右栏有「文件」分区（文件树）')
  ok(!secs.includes('rp-env'), '「环境」分区已移除（信息在别处，不再重复）')

  /*
   * 版本信息：排查“改了代码但跑的还是旧进程/旧包”时，
   * 界面上能直接看到构建时间就是最短路径（用户实际踩过一次）。
   */
  log('')
  log('=== 7. 关于：正式版本与构建版本 ===')
  store.getState().openSettings('about')
  await sleep(500)
  const rel = q('[data-testid="about-release"]')?.textContent ?? ''
  const bld = q('[data-testid="about-build"]')?.textContent ?? ''
  log('  正式版本行 = ' + JSON.stringify(rel))
  log('  构建版本行 = ' + JSON.stringify(bld))
  ok(/\d+\.\d+\.\d+/.test(rel), '显示正式版本号（来自 package.json）')
  ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(bld), '显示构建时间（构建时注入的本地时间）')
  ok(/[0-9a-f]{7}/.test(bld), '显示 git 短 hash（能对应到具体提交）')
  store.getState().closeSettings()

  return out.join('\n')
})()
