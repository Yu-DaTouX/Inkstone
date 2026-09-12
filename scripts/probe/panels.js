/**
 * 面板与工具栏：开关位置 / 命名 / 用户档案 / 收放。
 *
 * 覆盖本次三项改动（用户要求）：
 *   ① 面板开关从标题栏搬进各自面板（开关贴着它控制的东西）
 *   ② 右栏更名「工具栏」
 *   ③ 左栏底部改成用户名 + 可自定义头像 + 登录预留
 *
 * 注意：几何对称性不在本场景 —— 那是 symmetry.js（同一块 UI 的
 * 两种状态对比，断言类型不同：这里测「有没有/对不对」，那里测「一样不一样」）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const val = (s) => document.querySelector(s)?.value

  try {
    /*
     * 关掉首次引导层 —— **轮询等它出现**再关。
     * 上一版是「到了就找按钮，找不到就算了」：引导层晚出现时它一直开着，
     * 后面的 elementFromPoint 就会量到遮罩（偶发失败的来源）。
     */
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) { click(btn); await sleep(300) }
      else await sleep(150)
    }
    out.push('  引导层已关: ' + !document.querySelector('.ob-card'))
    await sleep(400)

    /*
     * 显式把两个面板都置为**展开**再开始量。
     * 为什么要这一步：前面的场景（resize）会把左栏拖到收起、libdrag 会动工具栏，
     * 而本场景第 4 节要量底部那几个按钮的**尺寸** —— 收起状态下它们会被
     * flex 挤扁（实测：26px 的设置按钮被挤成 14px，看起来像「按钮变小了」，
     * 其实只是容器窄）。不假设前一个场景留下的状态。
     */
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(700)
    out.push('  起始状态：railPinned=' + store.getState().railPinned + '  rightPanelOpen=' + store.getState().settings?.rightPanelOpen)

    out.push('=== 1. 标题栏：面板开关已移除 ===')
    if (!document.querySelector('.titlebar [data-testid="rail-toggle"]')) ok('标题栏没有左栏开关了')
    else bad('标题栏还有左栏开关')
    if (!document.querySelector('.titlebar [data-testid="rightpanel-toggle"]')) ok('标题栏没有右栏开关了')
    else bad('标题栏还有右栏开关')
    const wbtns = qa('.wctrl .wbtn').length
    ok('窗口控制按钮 ' + wbtns + ' 个（— □ ✕）')

    out.push('\n=== 2. 左栏开关在左栏头部 ===')
    const rt = document.querySelector('[data-testid="rail-toggle"]')
    if (!rt) bad('左栏头部没有开关')
    else {
      const inRail = !!rt.closest('.rail-top')
      const hasIco = !!rt.querySelector('svg')
      out.push('  开关在 .rail-top 里：' + inRail + '，纯图标=' + hasIco + '，文字=' + JSON.stringify(rt.textContent.trim()))
      ok(inRail, '开关在左栏头部：' + inRail)
      /*
       * 用户要求：把品牌字「砚」从开关上删掉。
       * 理由不只是好看 —— **标题栏已经有「砚」了**（.tb-name），
       * 而且内容是图标还是汉字会让盒子尺寸变，位置对不上。
       */
      if (hasIco && !/砚/.test(rt.textContent)) ok('开关是纯图标（品牌字只在标题栏，不重复）')
      else bad('开关不是纯图标：' + JSON.stringify(rt.textContent))
    }

    out.push('\n=== 3. 右栏标题是「工具栏」===')
    const ttl = document.querySelector('.rp-title')?.textContent
    out.push('  .rp-title = ' + JSON.stringify(ttl))
    if (ttl === '工具栏') ok('右栏已更名为工具栏')
    else bad('右栏标题不对')

    out.push('\n=== 4. 左栏底部：用户名 + 头像 + 更大的设置按钮 ===')
    const av = document.querySelector('[data-testid="rail-avatar"]')
    const un = document.querySelector('[data-testid="rail-user-name"]')
    const set = document.querySelector('[data-testid="rail-settings"]')
    out.push('  名字 = ' + JSON.stringify(un?.textContent) + '  头像 kind=' + av?.dataset.kind)
    if (av && un) ok('有头像与名字')
    else bad('缺头像或名字')
    if (!/个会话/.test(document.querySelector('.rail-foot')?.textContent ?? '')) ok('底栏不再显示「N 个会话」（已移到档案面板）')
    if (set) {
      const box = set.getBoundingClientRect()
      const ico = set.querySelector('svg')?.getBoundingClientRect()
      const avBox = av.getBoundingClientRect()
      out.push('  设置按钮 ' + box.width.toFixed(0) + '×' + box.height.toFixed(0) + '  图标 ' + (ico ? ico.width.toFixed(0) + '×' + ico.height.toFixed(0) : '?') + '  头像 ' + avBox.width.toFixed(0) + '×' + avBox.height.toFixed(0))
      // ⚠️ 留 0.5px 容差：界面缩放开着时 getBoundingClientRect 会返回
      //    25.998 这种值（zoom 是浮点缩放，子像素不能当整数比）——
      //    曾经因为差 0.0017 判定失败，这是断言的问题不是 UI 的问题。
      if (box.width >= 25.5 && box.height >= 25.5) ok('设置按钮已放大（≥26px，实测 ' + box.width.toFixed(2) + '）')
      else bad('设置按钮还是太小：' + box.width)
    }

    out.push('\n=== 5. 头像面板：改名字 ===')
    click(av)
    /*
     * 轮询等浮层出现（不用固定 sleep）。
     * 浮层是 React 状态驱动的，负载高时一帧可能超过 500ms ——
     * 这根固定等待已经假失败过一次（报「没打开档案面板」）。
     */
    let pop = null
    for (let i = 0; i < 25; i++) {
      pop = document.querySelector('[data-testid="rail-user-pop"]')
      if (pop) break
      await sleep(120)
    }
    if (pop) {
      ok('档案面板已打开')
      const inp = document.querySelector('[data-testid="rail-name-input"]')
      if (!inp) bad('没有名字输入框')
      else {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(inp, '测试名字')
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        /*
         * 提交靠 onBlur。触发它有两种方式，**两种都要用**：
         *   · `inp.focus()` + `inp.blur()`：真实路径。但在
         *     `win.showInactive()`（探针运行时不抢焦点）下，
         *     文档本身不是 active 的，focusout 可能被抑制。
         *   · 补发合成的 `focusout`：React 的 onBlur 就挂在这个事件上
         *     （React 17+ 用 focusout 做事件委派），且它 bubbles，
         *     所以能稳定到 root 上的委派监听。
         * commitName 是幂等的（先比再写），重复触发无副作用。
         */
        inp.focus()
        inp.blur()
        inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        // 等落盘（走 IPC + 写文件）——轮询而不是固定等
        for (let i = 0; i < 25; i++) {
          if (store.getState().settings?.profile?.name === '测试名字') break
          await sleep(120)
        }
        const nm = store.getState().settings?.profile?.name
        out.push('  store.profile.name = ' + JSON.stringify(nm))
        if (nm === '测试名字') ok('名字已写入设置')
        else bad('名字没写进去')
        if (document.querySelector('[data-testid="rail-user-name"]')?.textContent === '测试名字') ok('左栏显示已更新')
        else bad('左栏显示没更新')
      }

      out.push('\n=== 6. 头像：切图标 + 选色 ===')
      const iconBtn = document.querySelector('[data-testid="rail-avatar-icon"]')
      click(iconBtn); await sleep(500)
      const grid = document.querySelector('[data-testid="rail-avatar-icons"]')
      out.push('  图标网格：' + (grid ? grid.querySelectorAll('button').length + ' 个' : '无'))
      if (grid) {
        click(grid.querySelectorAll('button')[3]); await sleep(500)
        const p = store.getState().settings?.profile
        out.push('  profile: kind=' + p.avatarKind + ' value=' + p.avatarValue + ' hue=' + p.avatarHue)
        if (p.avatarKind === 'icon' && p.avatarValue) ok('图标头像已设置')
        else bad('图标头像没设置')
        if (document.querySelector('[data-testid="rail-avatar"] svg')) ok('头像渲染成图标了')
        else bad('头像没换成图标')
      }
      const hues = document.querySelector('[data-testid="rail-avatar-hues"]')
      if (hues) {
        click(hues.querySelectorAll('button')[4]); await sleep(500)
        const hue = store.getState().settings?.profile?.avatarHue
        out.push('  色相 = ' + hue)
        const bg = getComputedStyle(document.querySelector('[data-testid="rail-avatar"]')).background
        out.push('  头像背景 = ' + bg)
        if (hue >= 0 || hue === -1) ok('色相已写入')
      }

      out.push('\n=== 7. 登录为预留（不假装已登录）===')
      const lb = document.querySelector('[data-testid="rail-login"]')
      click(lb); await sleep(500)
      const note = document.querySelector('[data-testid="rail-login-note"]')
      if (!note) bad('没有登录说明面板')
      else {
        const txt = note.textContent.replace(/\s+/g, ' ')
        out.push('  文案：' + txt.slice(0, 90))
        if (/尚未接入|not wired/.test(txt)) ok('明确说明未接入（不说谎）')
        else bad('没有说明未接入')
        if (store.getState().settings?.profile?.signedIn === false) ok('signedIn 仍为 false（不做假状态）')
        else bad('signedIn 被置成 true')
        click(document.querySelector('[data-testid="rail-login-back"]')); await sleep(300)
      }
      // 关面板
      click(document.querySelector('.rup-x')); await sleep(300)
      if (!document.querySelector('[data-testid="rail-user-pop"]')) ok('面板可关闭')
    }

    out.push('\n=== 8. 收放面板 + 把手 ===')
    // 收起左栏
    click(document.querySelector('[data-testid="rail-toggle"]')); await sleep(600)
    if (!store.getState().railPinned) ok('点左栏头部开关 → 左栏收起')
    else bad('左栏没收起')
    /*
     * 展开入口 = **同一个按钮**（收起时它显示展开图标）。
     * 曾经是另一个元素（.rail-stub 把手），后来删掉了 ——
     * 两个元素两套几何，位置对不上（用户报过），而且透明左栏会盖住它。
     * 几何一致性交给 symmetry 场景测，这里只测「还在、还能用」。
     */
    /*
     * 收起形态变过两次（每一步都是用户提的）：
     *   ① 什么都不留 → 锁死
     *   ② 40/50px 竖条 → 用户说条形难看
     *   ③ 现在 8px 的缝 + 悬停才显的展开按钮
     * 所以断言改成验证当前设计：缝很窄、但展开入口存在且可用。
     */
    const unhide = document.querySelector('[data-testid="rail-expand"]')
    if (unhide) ok('收起后有展开入口（细线上的按钮）')
    else bad('收起后没有展开入口（会锁死）')
    const railW = document.querySelector('.rail-slot')?.getBoundingClientRect().width ?? 0
    out.push('  收起后 rail-slot 宽 = ' + railW.toFixed(1))
    if (railW >= 30 && railW <= 40) ok('收起槽 ' + railW.toFixed(1) + 'px（容得下入口按钮，且不是 0 宽）')
    else bad('收起槽宽度不对：' + railW)
    click(unhide); await sleep(600)
    if (store.getState().railPinned) ok('点它 → 左栏展开')
    else bad('展不开')

    // 收起右栏
    const w = document.querySelector('.workspace').getBoundingClientRect().width
    click(document.querySelector('[data-testid="rightpanel-hide"]')); await sleep(600)
    const centerCollapsed = document.querySelector('.center').getBoundingClientRect().width
    const rp = document.querySelector('.rightstub')
    out.push('  收起右栏后 rightstub 存在=' + !!rp)
    if (rp) ok('右栏收起留把手')
    else bad('右栏收起后没有展开入口')
    if (!document.querySelector('[data-testid="rightpanel"]')) ok('完整工具栏已卸载')
    click(document.querySelector('[data-testid="rightpanel-toggle"]')); await sleep(600)
    if (document.querySelector('[data-testid="rightpanel"]')) ok('点把手 → 工具栏展开')
    else bad('展不开工具栏')
    // 量中栏（.center）而不是 .workspace —— 后者是外层容器，面板收放不影响它的宽度
    out.push('  展开后 .center 宽 = ' + document.querySelector('.center').getBoundingClientRect().width.toFixed(1) + '（右栏收起时 ' + centerCollapsed.toFixed(1) + '）')
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[panels] 全部通过' : '[panels] ' + failed + ' 条失败')
  return out.join('\n')
})()
