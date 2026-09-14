/**
 * 任务模块的四条要求（用户消息 #17）。
 *
 *   ① 正在进行的任务在**任务本体上**显示，不单独开一栏
 *   ② 单个任务最多两行（完整文本放 title）—— 用户新要求，之前是 18 字
 *   ③ 全部任务完成时，任务栏自动收起（用户新要求）
 *   ③ 有历史任务就显示折叠模块，没有就不显示
 *   ④ 旁边有「历史任务查看 + 跳转」
 *
 * 历史数据来自会话里每一轮写的任务清单快照（main/agent.ts 的
 * todoSnapshotsFromEntries）—— 上一版只留最后一份，所以界面上看不到历史。
 * 这个场景直接注入快照，不需要真跑模型。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const qa = (s) => [...document.querySelectorAll(s)]
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const mk = (spec) => spec.map(([text, done]) => ({ text, done }))

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(600)

    const LONG = '这是一个特别特别长的任务描述超过十八个字应该被截断显示'
    const cur = mk([['写完文档', true], [LONG, false], ['跑测试', false]])
    const past1 = mk([['调研方案', true], ['写初稿', true]])
    const past2 = mk([['列大纲', true]])

    /*
     * 「正在进行」是**推断**出来的（第一个未完成 + 回合在跑，见 RightPanel 的
     * activeIdx），所以注入任务前必须把会话标成运行中 —— 否则下面那些
     * 「有 active 行」的断言测的就是旧行为（停下也硬说有人在跑）。
     */
    const setRunning = (v) => {
      const s = store.getState().session
      store.setState({ session: { ...(s ?? {}), isAgentRunning: v, isStreaming: v } })
    }
    setRunning(true)
    await sleep(200)

    out.push('=== 1. 注入两轮历史 + 当前一份 ===')
    store.setState({
      todos: cur,
      todoHistory: [
        { id: 'h1', todos: past1, round: 1 },
        { id: 'h2', todos: past2, round: 2 },
        { id: 'h3', todos: cur, round: 3 }
      ]
    })
    await until(() => document.querySelector('[data-testid="rp-todo"]'), 4000)
    await sleep(500)
    const sec = document.querySelector('[data-testid="rp-todo"]')
    if (sec) ok('任务分区存在')
    else bad('任务分区没渲染')

    out.push('\n=== 2. 「正在做」在任务本体上，不再单独一栏 ===')
    if (!document.querySelector('[data-testid="todo-now"]')) ok('没有单独的「正在做」那一行（已删）')
    else bad('还留着单独的一行')
    const activeRow = document.querySelector('.rp-todo[data-active="1"]')
    out.push('  active 行: ' + JSON.stringify(activeRow?.textContent?.trim()))
    if (activeRow) ok('有且只有当前任务那一行带 active')
    else bad('没有 active 行')
    const label = document.querySelector('[data-testid="todo-active-label"]')
    out.push('  行内标签: ' + JSON.stringify(label?.textContent?.trim()))
    if (label && /正在进行/.test(label.textContent)) ok('「正在进行」显示在任务本体上')
    else bad('任务行里没有「正在进行」')
    if (label && label.querySelector('.rp-now-spin')) ok('标签带 spinner')
    else bad('标签没有 spinner')
    if (qa('.rp-todo[data-active="1"]').length === 1) ok('只有一条被标为 active')
    else bad('active 条数不对：' + qa('.rp-todo[data-active="1"]').length)

    out.push('\n=== 2b. 回合停下后不再冒充「正在进行」（方案 4.5）===')
    setRunning(false)
    await sleep(400)
    if (!document.querySelector('.rp-todo[data-active="1"]')) ok('停下后没有条目被标为 active')
    else bad('停下了还在标 active')
    if (!document.querySelector('[data-testid="todo-active-label"]')) ok('停下后不再有转圈的标签')
    else bad('停下后还有 spinner 在转')
    setRunning(true)

    out.push('\n=== 3. 任务文字最多两行 ===')
    const cells = qa('.rp-todos .rp-text')
    const texts = cells.map((e) => e.textContent)
    out.push('  渲染的任务文字: ' + JSON.stringify(texts))
    const longCell = cells.find((e) => e.textContent.includes('特别特别长'))
    if (longCell) {
      const cs = getComputedStyle(longCell)
      const clamp = cs.getPropertyValue('-webkit-line-clamp') || cs.webkitLineClamp
      const lineH = parseFloat(cs.lineHeight) || 20
      const maxH = parseFloat(cs.maxHeight)
      out.push('  display=' + cs.display + ' line-clamp=' + clamp + ' max-height=' + cs.maxHeight + ' line-height=' + cs.lineHeight)
      if (String(clamp) === '2') ok('声明了 -webkit-line-clamp: 2')
      else bad('行数限制不对：' + clamp)
      if (cs.overflow === 'hidden' && Number.isFinite(maxH) && maxH <= lineH * 2 + 2) {
        ok('高度被夹在两行内（max-height + overflow hidden）')
      } else {
        bad('两行夹取未生效（overflow=' + cs.overflow + ' max-height=' + cs.maxHeight + '）')
      }
      // 27 字的文本不应再被按 18 字硬截（两行能放满）
      if (!longCell.textContent.includes('…')) ok('没有按 18 字硬截（' + longCell.textContent.length + ' 字符）')
      else bad('仍然在按字数截断：' + JSON.stringify(longCell.textContent))
    } else bad('没找到超长任务那个格子')
    const longRow = qa('.rp-todo').find((r) => r.getAttribute('title')?.includes('特别特别长'))
    if (longRow) ok('完整文本在 title 里（悬停可见，没丢信息）')
    else bad('没有 title，信息丢了')

    out.push('\n=== 4. 历史任务：折叠模块 + 跳转 ===')
    const hist = document.querySelector('[data-testid="todo-history"]')
    if (hist) ok('有历史任务时出现折叠模块')
    else bad('没有历史任务模块')
    const toggle = document.querySelector('[data-testid="todo-history-toggle"]')
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') ok('默认收起（折叠模块）')
    else bad('默认状态不对')
    click(toggle)
    const opened = await until(() => document.querySelector('[data-testid="todo-hist-2"]'), 3000)
    const items = qa('.rp-hist-item').map((x) => x.dataset.testid)
    out.push('  展开后: ' + JSON.stringify(items))
    if (opened) ok('点开能看到历史清单（新的在前）')
    else bad('点开后没有内容')
    if (items[0] === 'todo-hist-2') ok('最近的排在最前（第 2 轮 → 第 1 轮）')
    else bad('排序不对：' + JSON.stringify(items))
    if (items.length === 2) ok('只列历史（不含当前那份），数量 ' + items.length)
    else bad('数量不对（当前那份不该进历史）：' + items.length)

    const jumps = qa('.rp-hist-jump')
    out.push('  跳转按钮: ' + jumps.length + ' 个')
    if (jumps.length === 2) ok('每份历史都有「跳转」')
    else bad('跳转按钮数量不对')
    const jump = document.querySelector('[data-testid="todo-hist-jump-2"]')
    if (jump) {
      jump.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(400)
      out.push('  点「第 2 轮」的跳转后 store.scrollToTurn 被调用（无法直接断言滚动，看无异常）')
      ok('跳转按钮可点且不抛错')
    }

    out.push('\n=== 5. 没有历史时不显示模块 ===')
    store.setState({ todoHistory: [{ id: 'only', todos: cur, round: 1 }] })
    await sleep(600)
    if (!document.querySelector('[data-testid="todo-history"]')) ok('只有当前一份时不显示历史模块')
    else bad('没有历史却显示了模块')

    out.push('\n=== 6. 没有任务时不渲染任务分区 ===')
    store.setState({ todos: [], todoHistory: [] })
    await sleep(600)
    if (!document.querySelector('[data-testid="rp-todo"]')) ok('空任务不占位')
    else bad('空任务还渲染了分区')

    out.push('\n=== 7. 全部完成自动收起；新任务再展开（用户新要求）===')
    const secOpen = () => !!document.querySelector('[data-testid="rp-todo"].open')
    store.setState({ todos: mk([['甲', true], ['乙', false]]), todoHistory: [] })
    await sleep(500)
    if (secOpen()) ok('有未完成任务时任务栏展开')
    else bad('有未完成任务却没展开')
    store.setState({ todos: mk([['甲', true], ['乙', true]]), todoHistory: [] })
    await sleep(600)
    if (!secOpen()) ok('全部完成后任务栏自动收起')
    else bad('全部完成了但没收起')
    if (!document.querySelector('.rp-todo')) ok('收起后任务行不在 DOM（真的收起了）')
    else bad('收起后任务行还在')
    store.setState({ todos: mk([['丙', false]]), todoHistory: [] })
    await sleep(600)
    if (secOpen()) ok('新任务出现后自动重新展开')
    else bad('新任务来了却没展开')
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[todonew] 全部通过' : '[todonew] ' + failed + ' 条失败')
  return out.join('\n')
})()
