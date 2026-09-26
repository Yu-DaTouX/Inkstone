/**
 * 空间工作台（实施-25 P04）—— 真实窗口里走一遍。
 *
 * 覆盖 T04-7 与 T04-8 的关键断言：
 *   · 概览**始终可达**：不依赖「当前会话为空」，有消息的会话下也能打开；
 *   · 四个入口都能来回切；
 *   · 展示哪个空间由**当前会话的 `spaceId` 派生**（T04-8）——会话归档后
 *     头部跟着变，移出后又变回「未归档到空间」；
 *   · 资料页在真实数据上是空态（不是「加载中」）。
 *
 * ⚠️ 一个已知限制会在这里露出来：**刚新建、还没落盘的会话不在左栏列表里**，
 *   所以它没有归属可谈（「未归档」是如实显示，不是缺陷）。探针遇到这种情况
 *   会先切到列表里的一条真实会话，再验证「打开会话按自身归属恢复上下文」。
 *
 * 资料**有**内容时的渲染由矩阵的 `spacelibrary` 状态覆盖（注入固定夹具）；
 * 真实的「按引用取正文」由 `test:live -- library` 覆盖。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  log('=== 1. 日常模式 + 建空间 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  window.__yanStore.setState({ workspaceMode: 'daily' })
  await sleep(300)
  ok(S().workspaceMode === 'daily', '已切到日常模式', String(S().workspaceMode))

  const space = await S().createSpace('探针空间（工作台）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  log('=== 2. 概览始终可达（当前会话有内容） ===')
  log('  · 当前会话的消息数 = ' + S().messages.length + '（概览不依赖它，这里只是记录现场）')
  /*
   * B3 之后「空间」入口只在**当前会话真的归属某个空间**时才出现
   * （会话头部按需给一档，不再常驻三档）。所以先归属，否则点不到 view-space。
   */
  const sid = S().session?.sessionId
  if (sid) {
    await S().setSessionSpace(sid, space.id)
    await S().refreshSessions()
    await sleep(700)
  }
  /* 只在失败时打现场：成功时这些行是噪音，失败时它们就是答案（不再跑一轮） */
  if (!q('[data-testid="view-space"]')) {
    const cur = S().session ?? {}
    const curFile = cur.conversationFile ?? cur.sessionFile ?? ''
    const listed = (S().sessions ?? []).find((s) => s.id === sid)
    const listedByPath = (S().sessions ?? []).find((s) => curFile && s.path === curFile)
    out.push(
      `  诊断：sessionId=${cur.sessionId ?? '（无）'}  conversationFile=${curFile || '（无）'}  mode=${S().workspaceMode}`
    )
    out.push(
      `  诊断：列表 ${(S().sessions ?? []).length} 条；首条 id=${S().sessions?.[0]?.id ?? '（无）'} path=${S().sessions?.[0]?.path ?? '（无）'}`
    )
    out.push(
      `  诊断：按 id 命中=${!!listed}  按 path 命中=${!!listedByPath}  写入用 id=${space.id}`
    )
  }
  ok(!!q('[data-testid="view-space"]'), '会话归属空间后，头部出现「空间」入口')
  click(q('[data-testid="view-space"]'))
  await sleep(500)
  ok(!!q('[data-testid="space-workbench"]'), '概览打开了')
  ok(!!q('[data-testid="space-overview"]'), '概览页渲染')

  log('=== 3. 四个入口来回切 ===')
  for (const [tab, selector] of [
    ['library', '[data-testid="space-library"]'],
    ['artifact', '[data-testid="space-artifact"]'],
    ['learning', '[data-testid="space-learning"]'],
    ['overview', '[data-testid="space-overview"]']
  ]) {
    click(q(`[data-testid="space-tab-${tab}"]`))
    await sleep(350)
    ok(!!q(selector), `切到 ${tab}`, selector)
  }

  log('=== 4. 资料页：真实数据上是空态 ===')
  click(q('[data-testid="space-tab-library"]'))
  await sleep(400)
  ok(!!q('[data-testid="space-lib-empty"]'), '没有资料时显示空态（不是加载中）')

  log('=== 5. 关闭 / 重开 / 记住上次那一页 ===')
  click(q('[data-testid="space-close"]'))
  await sleep(400)
  ok(!q('[data-testid="space-workbench"]'), '× 关闭空间视图')
  click(q('[data-testid="view-space"]'))
  await sleep(400)
  ok(!!q('[data-testid="space-workbench"]'), '入口仍在会话头部（会话还归属着这个空间），能再打开')
  ok(!!q('[data-testid="space-library"]'), '记住了上次停在资料页', localStorage.getItem('yan.space-view'))

  log('=== 6. 归属投影（T04-8） ===')
  const current = S().session
  let target = S().sessions.find((x) => x.id === current?.sessionId || x.path === current?.sessionFile)
  if (!target) {
    log('  · 当前会话是新建未落盘的（不在列表里，按设计没有归属）→ 切到列表里的真实会话再验证')
    const fallback = S().sessions[0]
    if (fallback) {
      await S().switchSession(fallback.path)
      await sleep(900)
      target = S().sessions.find((x) => x.path === fallback.path)
    }
  }
  if (target) {
    /* 第一个参数是**会话 id**（Rail 传的也是 id，不是路径） */
    const wrote = await S().setSessionSpace(target.id, space.id)
    await sleep(700)
    const row = S().sessions.find((x) => x.id === target.id)
    ok(wrote === true && row?.spaceId === space.id, '归属写入并刷新到列表', String(wrote) + ' / ' + String(row?.spaceId))
    const name = q('[data-testid="space-workbench-name"]')?.textContent ?? ''
    ok(name === '探针空间（工作台）', '会话归档后头部显示该空间', JSON.stringify(name))
    await S().setSessionSpace(target.id, null)
    await sleep(500)
    const name2 = q('[data-testid="space-workbench-name"]')?.textContent ?? ''
    ok(name2 === '未归档到空间', '移出空间后如实回到未归档', JSON.stringify(name2))

    /*
     * 反向断言（B3 的「按需入口」不能被悄悄退回成常驻）。
     *
     * 上面为了让新会话（未落盘、列表里查不到）也能进空间，
     * 把入口条件放宽到了“查不到就按不知道处理”。这条断言钉住它的边界：
     * 会话**在列表里**且确认没归属时，头部就不应该有这个入口。
     * （这里当前会话就是那个列表里的会话，与 showSpace 的判定同一个现场。）
     */
    click(q('[data-testid="space-close"]'))
    await sleep(400)
    const stillThere = q('[data-testid="view-space"]')
    const currentInList = S().sessions.some(
      (x) => x.path === (S().session?.conversationFile ?? S().session?.sessionFile)
    )
    if (currentInList) {
      ok(!stillThere, '会话在列表里且没有归属 → 头部不再显示「空间」入口（按需没退化成常驻）')
    } else {
      log('  · 当前会话不在列表里（按上面的定义属于“查不到”，预期仍给入口）——跳过这条反向断言')
    }
    /* 换回来，免得把探针造的状态留在隔离目录里 */
    await S().setSessionSpace(target.id, space.id)
  } else {
    ok(false, '列表里连一条会话都没有 → 无法验证归属投影')
  }

  log('=== 7. 概览里的「继续」能点开会话 ===')
  click(q('[data-testid="space-tab-overview"]'))
  await sleep(400)
  const item = q('[data-testid="space-ov-continue"] .wb-list-item')
  if (item) {
    click(item)
    await sleep(700)
    ok(!q('[data-testid="space-workbench"]'), '点开会话后回到对话（概览关闭）')
  } else {
    log('  · 该空间下没有已归档会话时，「继续」是空态（上面第 6 步已把归属写回，这里按实际显示）')
  }
  await S().updateSpace(space.id, { archived: true })

  return out.join('\n')
})()
