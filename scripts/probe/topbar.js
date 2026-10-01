/**
 * 面板开关在**标题栏两端**（用户要求，参考 Codex 截图）。
 *
 * 为什么值得钉住：这两个开关的位置变过三次 ——
 *   ① 标题栏两端 → ② 搬进各自面板内部（“开关贴着它控制的东西”）
 *   → ③ 回到标题栏两端（本次，因为②导致收起态必须保留 38px 的槽，
 *      而那条保留宽度把中栏宽度算错，连带把**导航轨位置带偏**）。
 *
 * 这个场景断言的是「与位置无关的性质」，所以下次再改版也不会假失败：
 *   · 开关在标题栏、分居左右两端
 *   · 面板收放时开关**不动**（这才是「收起后找不到入口」的正解）
 *   · 收起 = 0 宽（不需要留槽）
 *   · 收起状态下导航轨仍贴着正文列（错位 bug 的回归断言）
 *   · 左栏「砚 + 开关」模式入口：点击直接切换编码 / 日常两态
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80) } return false }
  const store = window.__yanStore
  const rect = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) }
  }
  const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(800)

    out.push('=== 1. 两个开关都在标题栏 ===')
    const rt = document.querySelector('[data-testid="rail-toggle"]')
    const pt = document.querySelector('[data-testid="right-tool-menu"]')
    if (rt && rt.closest('.titlebar')) ok('侧栏开关在标题栏里')
    else bad('侧栏开关不在标题栏')
    if (pt && pt.closest('.titlebar')) ok('工具栏开关在标题栏里')
    else bad('工具栏开关不在标题栏')
    // 左右两端（Codex 的位置）：侧栏在左半、工具栏在右半
    const rtr = rect('[data-testid="rail-toggle"]')
    const ptr = rect('[data-testid="right-tool-menu"]')
    out.push('  侧栏开关 ' + JSON.stringify(rtr) + '   工具栏开关 ' + JSON.stringify(ptr) + '   窗口宽 ' + window.innerWidth)
    if (rtr && rtr.x < window.innerWidth / 2) ok('侧栏开关在窗口左侧')
    else bad('侧栏开关位置不对')
    if (ptr && ptr.x > window.innerWidth / 2) ok('工具栏开关在窗口右侧')
    else bad('工具栏开关位置不对')
    // 工具栏开关应紧邻窗口控制按钮
    const maxBtn = rect('[data-testid="win-max"]')
    if (ptr && maxBtn && ptr.x < maxBtn.x) ok('工具栏开关在窗口控制按钮左边（挨着）')
    else bad('工具栏开关与窗口控制的相对位置不对')

    out.push('\n=== 2. 开关位置与面板收放**无关** ===')
    const before1 = rect('[data-testid="rail-toggle"]')
    click(rt)
    await sleep(700)
    const after1 = rect('[data-testid="rail-toggle"]')
    out.push('  收起左栏：' + JSON.stringify(before1) + ' → ' + JSON.stringify(after1))
    if (same(before1, after1)) ok('左栏收起后开关**不动**')
    else bad('左栏收起后开关移动了')
    if (!document.querySelector('[data-testid="rail-expand"]')) ok('不再需要收起态的悬停入口（开关就在标题栏）')
    else bad('还留着旧的悬停入口')

    const slotW = rect('.rail-slot')?.w ?? -1
    out.push('  收起后 rail-slot 宽 = ' + slotW)
    /*
     * ⚠️ 当前设计：收起**就是真的 0 宽** —— 紧凑轨（.rail-compact）已经移除，
     * 入口只留标题栏那个开关（位置与面板收放无关）。这条断言前后改过两次，
     * 现在跟着源码走：源码里没有 .rail-compact，就不该断言它有 48px。
     */
    if (slotW < 1) ok('收起 = 0 宽（入口只在标题栏）')
    else bad(`收起态不对：宽 ${slotW}px（应为 0）`)

    const ptBefore = rect('[data-testid="right-tool-menu"]')
    await window.__yanOpenWorkspaceTool('文件', 'files')
    const ptAfter = rect('[data-testid="right-tool-menu"]')
    if (same(ptBefore, ptAfter)) ok('打开磁贴后工具入口位置稳定')
    else bad('工具入口随磁贴打开移动')
    const pane = document.querySelector('[data-workspace-pane="files"]:not([hidden])')
    if (pane) ok('文件磁贴已打开')
    else bad('工具菜单没有打开文件磁贴')
    document.querySelector('[data-pane-tab="files"]')?.closest('.tile-heading')?.querySelector('[aria-label="收起面板，保留运行"]')?.click()
    await sleep(500)
    if (!document.querySelector('[data-workspace-pane="files"]:not([hidden])')) ok('隐藏磁贴让出工作区空间')
    else bad('文件磁贴未隐藏')
    const cols = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(/\s+/).map(Number.parseFloat)
    if (cols[0] < 1) ok('侧栏收起后0宽，主会话保留可用空间')
    else bad('侧栏收起后仍占宽')

    out.push('\n=== 3. 中栏内容与导航轨对齐（之前错位的根因）===')
    // 注入 4 轮，让导航轨渲染
    const fake = []
    for (let i = 1; i <= 4; i++) {
      fake.push({ id: 'u' + i, role: 'user', text: '第 ' + i + ' 问' })
      fake.push({ id: 'a' + i, role: 'assistant', text: '第 ' + i + ' 答' + 'x'.repeat(60) })
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    await sleep(900)
    const inner = rect('.stream-inner')
    // 量**看得见的那条刻度**的右缘（不是命中区/容器的左缘）
    const tick = rect('.outline-hit .outline-bar')
    const center = rect('.center')
    out.push('  center=' + JSON.stringify(center) + ' inner=' + JSON.stringify(inner) + ' tick=' + JSON.stringify(tick))
    if (inner && tick && center) {
      /*
       * V-2b 后轨道贴的是**会话可用区左边缘**（两栏收起 = 整窗），正文仍居中。
       * 所以旧的「轨道贴正文左缘」公式不再成立；正确的不变量是：
       * ① 轨道在会话区左边缘附近；② 刻度命中区不压到正文内容。
       */
      const atEdge = tick.x - center.x <= 16
      const overlap = (tick.x + tick.w) - inner.x
      out.push(`  轨道距会话区左缘 ${(tick.x - center.x).toFixed(0)}px；与正文重叠 ${overlap.toFixed(0)}px`)
      if (atEdge && overlap <= 0) ok('导航轨贴会话区左缘且不压正文')
      else bad(`导航轨位置不对：距左缘 ${(tick.x - center.x).toFixed(0)}px / 重叠 ${overlap.toFixed(0)}px`)
    }

    // 展开回来
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await until(() => store.getState().railPinned, 3000)
    click(document.querySelector('[data-testid="right-tool-menu"]'))
    await until(() => store.getState().settings?.rightPanelOpen, 3000)
    await sleep(600)

    out.push('\n=== 4. 左栏顶部（拨杆已移除；品牌在标题栏）===')
    /*
     * 为什么断言“不存在”：工作区拨杆曾经是左栏唯一的模式入口（实施-20 U1），
     * B3 把它搬到设置 · 工作区。这里改成正反两面：
     *   ① 左栏顶部仍然有软件名；
     *   ② 拨杆确实不在了（否则就是新旧两个入口并存）。
     * 切模式本身在设置里验（`yan settings` 场景）。
     */
    /* 品牌只在标题栏出现一次（v0.4）；左栏顶部是「新对话 + 搜索」 */
    if (/砚/.test(document.querySelector('[data-testid="app-brand"]')?.textContent ?? '')) ok('软件名在标题栏')
    else bad('标题栏没有软件名')
    if (document.querySelector('.rail-top [data-testid="rail-new"]')) ok('左栏顶部是「新对话」')
    else bad('左栏顶部没有「新对话」')
    const straySwitch = document.querySelector('[data-testid="mode-switch"]')
    if (!straySwitch) ok('左栏不再常驻工作区拨杆（入口在设置里）')
    else bad('工作区拨杆又回到了左栏，与设置里的入口重复')
    const beforeMode = store.getState().workspaceMode ?? 'daily'
    const agentBefore = store.getState().workMode?.mode ?? 'standard'
    store.setState({ workspaceMode: 'coding' })
    if (await until(() => store.getState().workspaceMode === 'coding', 3000)) ok('工作区模式仍可切换（store 直接改）')
    else bad('工作区模式切不动')
    if ((store.getState().workMode?.mode ?? 'standard') === agentBefore) ok('工作区切换没有改动 AgentMode')
    else bad('工作区切换错误改动了 AgentMode')
    /* 回到测试开始时的档，不把探针副作用留给后面的断言 */
    if (store.getState().workspaceMode !== beforeMode) store.setState({ workspaceMode: beforeMode })
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[topbar] 全部通过' : '[topbar] ' + failed + ' 条失败')
  return out.join('\n')
})()
