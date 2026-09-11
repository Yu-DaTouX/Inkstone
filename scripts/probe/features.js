;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s)
    return !!cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const setVal = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const keydown = (el, key, opts = {}) =>
    el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, opts)))

  log('=== 阶段 2 功能验收 ===')

  const store = window.__yanStore

  // 任何面板的模态遮罩都会挡住点击 —— 每段测试前都确保它是关的。
  // （记忆/状态搬进设置后，测试会开面板，之后忘了关就会让后续点击全部失效）
  const ensureClosed = async () => {
    if (window.__yanStore.getState().settingsOpen) {
      window.__yanStore.getState().closeSettings()
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /* ---- 前置：等 pi 连上 ----
     conn 不是 ready 时输入框是 disabled 的，发送键点不动。
     之前没等，所以 !bash 那段会「角标对了但发不出去」——
     看着像功能坏了，其实是测试抢跑。 */
  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  const connNow = store.getState().conn
  log('pi 连接: ' + connNow)
  if (connNow !== 'ready') return fail('pi 未连上（conn=' + connNow + '），后面的功能测不了')

  /* ================= 1. 斜杠命令菜单 ================= */
  log('\n--- 1. 斜杠命令 ---')
  const ta = q('[data-testid="composer"]')
  if (!ta) return fail('找不到输入框')

  const cmdCount = store.getState().commands.length
  log('  pi 返回命令数: ' + cmdCount)

  setVal(ta, '/')
  await sleep(300)
  const menu = q('.slash-menu')
  ok(!!menu, '输入 / 弹出命令菜单')
  if (menu) {
    const items = qa('.slash-item')
    log('  菜单项: ' + items.map((i) => i.querySelector('.slash-name')?.textContent).join(', '))
    ok(items.length > 0, `菜单有 ${items.length} 项`)
    // 方向键移动
    keydown(ta, 'ArrowDown')
    await sleep(80)
    ok(q('.slash-item.sel') === qa('.slash-item')[1] || qa('.slash-item').length === 1, '方向键切换选中项')
    // Enter 补全
    keydown(ta, 'Enter')
    await sleep(150)
    ok(ta.value.startsWith('/') && ta.value.length > 1, `Enter 补全为 ${JSON.stringify(ta.value)}`)
    ok(!q('.slash-menu'), '补全后菜单收起')
  }
  setVal(ta, '')
  await sleep(100)

  /* ================= 2. bash 直执行 ================= */
  log('\n--- 2. ! 直执行 bash（不进模型）---')
  await ensureClosed()
  const nBefore = qa('.msg').length
  setVal(ta, '!echo yan-bash-feature-ok')
  await sleep(200)
  ok(!!q('.mode-badge.bash'), '出现 bash 模式角标')
  const bashSendBtn = q('[data-testid="send"]')
  ok(bashSendBtn.textContent.includes('执行'), '发送键变成「执行」')

  click(bashSendBtn)

  // 等命令跑完
  let bashDone = false
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const t = q('.msg.bash .tool')
    if (t && t.dataset.state !== 'running') {
      bashDone = true
      break
    }
  }
  await sleep(600)

  const bashMsg = q('.msg.bash')
  ok(!!bashMsg, '产生了 bash 消息')
  ok(bashDone, '命令执行完毕（状态不再是 running）')
  if (bashMsg) {
    // 用户主动执行的命令应当默认展开（否则看不到结果）
    ok(bashMsg.querySelector('.tool').classList.contains('open'), '默认展开（用户是为了看结果才跑的）')
    const outText = bashMsg.querySelector('.tool-pre.out')?.textContent ?? ''
    log('  输出: ' + JSON.stringify(outText.slice(0, 60)))
    ok(outText.includes('yan-bash-feature-ok'), '输出里能看到命令打印的内容')
    const st = bashMsg.querySelector('.tool-status')
    ok(!!st && st.classList.contains('ok'), '状态为成功')
  }
  ok(qa('.msg').length > nBefore, '消息数增加')
  ok(store.getState().session?.isStreaming !== true, '没有进入「模型流式」状态（确实绕过了模型）')

  // 失败的命令也应该展开且标记失败
  setVal(ta, '!exit 3')
  await sleep(150)
  click(q('[data-testid="send"]'))
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    const t = qa('.msg.bash .tool').pop()
    if (t && t.dataset.state !== 'running') break
  }
  await sleep(400)
  const lastBash = qa('.msg.bash').pop()
  if (lastBash) {
    // ⚠️ 失败**不自动展开**（刻意的：失败输出经常几十行）。
    // 所以断言要看卡片本身的 data-state，而不是内部的 .tool-status ——
    // 后者只在展开时渲染。
    const card = lastBash.querySelector('.tool')
    if (card) {
      ok(card.dataset.state === 'error', `非零退出码标记为失败（data-state=${card.dataset.state}）`)
    } else {
      // 连卡片都没有 → 说明消息结构有问题
      ok(false, '找不到 bash 工具卡')
    }
  }

  /* ================= 3. 图片附件（粘贴） ================= */
  log('\n--- 3. 图片附件 ---')
  await ensureClosed()
  // 1x1 PNG
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const file = new File([bytes], 'yan-test.png', { type: 'image/png' })

  const dt = new DataTransfer()
  dt.items.add(file)
  ta.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  )
  await sleep(500)

  const attach = qa('.attach')
  ok(attach.length === 1, `粘贴后出现 ${attach.length} 个附件缩略图`)
  if (attach.length) {
    const img = attach[0].querySelector('img')
    ok(!!img && img.src.startsWith('data:image/png;base64,'), '缩略图用 data URI 渲染')
    ok(
      (attach[0].querySelector('.attach-name')?.textContent ?? '').includes('yan-test.png'),
      '附件显示文件名'
    )
  }
  ok(store.getState().attachments.length === 1, '附件进了 store')

  // 移除
  if (attach.length) {
    click(attach[0].querySelector('.attach-del'))
    await sleep(300)
    ok(store.getState().attachments.length === 0, '点 ✕ 能移除附件')
    ok(!q('.attach'), '缩略图已消失')
  }

  // 去重：同名同大小只加一次
  store.getState().addAttachments([
    { id: 'a1', name: 'dup.png', mimeType: 'image/png', size: 10, data: b64, preview: b64 },
    { id: 'a2', name: 'dup.png', mimeType: 'image/png', size: 10, data: b64, preview: b64 }
  ])
  await sleep(150)
  ok(store.getState().attachments.length === 1, '同名同大小去重')
  store.getState().clearAttachments()
  await sleep(100)

  /* ================= 4. 模型 / 思考选择器 ================= */
  log('\n--- 4. 模型 / 思考选择器 ---')
  await ensureClosed()
  // 模型 / 思考档 现在在设置面板的「状态」tab 里
  store.getState().openSettings('status')
  await sleep(700)

  const picks = qa('.pick')
  ok(picks.length >= 2, `有 ${picks.length} 个下拉（模型 + 思考）`)

  const modelPick = picks[0]
  if (modelPick) {
    const opts = [...modelPick.querySelectorAll('option')]
    log('  模型选项数: ' + opts.length + ' 当前: ' + JSON.stringify(modelPick.value))
    ok(opts.length > 1, '模型下拉有多项')
    const groups = [...modelPick.querySelectorAll('optgroup')].map((g) => g.label)
    ok(groups.length > 0, '模型按 provider 分组: ' + groups.slice(0, 4).join(', '))

    const cur = store.getState().session?.model
    ok(
      modelPick.value === `${cur?.provider}|${cur?.id}`,
      '下拉当前值与 session.model 一致'
    )

    // 真正切一次再切回来
    const other = opts.find((o) => o.value && o.value !== modelPick.value)
    if (other) {
      const [p, id] = other.value.split('|')
      await store.getState().setModel(p, id)
      await sleep(1200)
      const after = store.getState().session?.model
      ok(after?.id === id, `切换到 ${id} 生效`)
      // 切回
      if (cur) {
        await store.getState().setModel(cur.provider, cur.id)
        await sleep(1200)
        ok(store.getState().session?.model?.id === cur.id, '切回原模型成功')
      }
    } else {
      log('  （只有一个模型，跳过切换测试）')
    }
  }

  const thinkPick = picks[1]
  if (thinkPick) {
    const opts = [...thinkPick.querySelectorAll('option')].map((o) => o.value)
    log('  思考档: ' + opts.join(', ') + ' 当前: ' + thinkPick.value)
    ok(opts.length > 0, '思考档下拉有选项')
    const orig = thinkPick.value
    const other = opts.find((o) => o !== orig)
    if (other) {
      await store.getState().setThinking(other)
      await sleep(1000)
      ok(store.getState().session?.thinkingLevel === other, `切到 ${other} 生效`)
      await store.getState().setThinking(orig)
      await sleep(1000)
      ok(store.getState().session?.thinkingLevel === orig, `切回 ${orig} 成功`)
    }
  }

  store.getState().closeSettings()
  await sleep(250)

  /* ================= 5. 自动压缩 / 重试开关 ================= */
  // 开关现在也在设置面板的「状态」tab 里
  store.getState().openSettings('status')
  await sleep(500)
  log('\n--- 5. 开关 ---')
  // 开关已从「复选框」改成「滑块按钮」（.switch-pill）
  const switches = qa('.settings-body .switch-pill')
  ok(switches.length === 2, `有 ${switches.length} 个开关（自动压缩 / 自动重试）`)

  const autoCompact = switches[0]
  if (autoCompact) {
    const before = store.getState().session?.autoCompactionEnabled
    log('  自动压缩当前: ' + before)
    const target = !before
    autoCompact.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1200)
    ok(
      store.getState().session?.autoCompactionEnabled === target,
      `切换后 autoCompactionEnabled = ${store.getState().session?.autoCompactionEnabled}（期望 ${target}）`
    )
    autoCompact.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(1200)
    ok(store.getState().session?.autoCompactionEnabled === before, '还原成功')
  }

  /* ================= 6. 会话重命名 ================= */
  // 左栏默认收起（自动隐藏模式）→ 断言前先把它展开，
  // 否则元素虽然在 DOM 里，但宽度是 0，可见性相关的判断会失效。
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 3, clientY: 400, bubbles: true }))
  await sleep(900)
  ok(!q('.app').classList.contains('rail-off'), '左栏已展开（后续断言依赖它可见）')

  log('\n--- 6. 会话重命名 ---')
  await ensureClosed()
  const NAME = 'yan-rename-test-' + Date.now().toString(36)
  const origName = store.getState().session?.sessionName ?? ''

  await store.getState().renameSession(NAME)
  await sleep(1500)
  ok(store.getState().session?.sessionName === NAME, `会话名 = ${NAME}`)

  // 左栏应能立即看到（当前会话可能还没落盘 → 靠合成条目显示）
  await store.getState().refreshSessions()
  await sleep(600)
  const railNames = qa('.rail .srow-name').map((e) => e.textContent)
  ok(
    railNames.includes(NAME) || !!q('.rail .srow.sel'),
    '左栏能看到这个名字（或当前会话条目）',
    JSON.stringify(railNames.slice(0, 3))
  )

  // 还原原名。注意：pi 不接受空名字（set_session_name 对空串返回 success:false），
  // 所以「原名是空」时清不掉 —— 这时改成一个无害的名字而不是硬要清空。
  const restore = origName || '未命名'
  await store.getState().renameSession(restore)
  await sleep(1500)
  ok(
    store.getState().session?.sessionName === restore,
    `还原名字（现在 = ${JSON.stringify(store.getState().session?.sessionName)}）`
  )

  // 空名字应该被拦住并给出理由，而不是静默失败
  const emptyRes = await window.yan.renameSession('   ')
  ok(emptyRes.ok === false, '空名字被拒绝')
  ok(
    (emptyRes.error ?? '').length > 0,
    '空名字被拒时给出理由：' + JSON.stringify(emptyRes.error)
  )

  /* ================= 7. 分叉点 ================= */
  log('\n--- 7. 分叉点查询 ---')
  const points = await window.yan.forkPoints()
  log('  当前会话可分叉点: ' + points.length)
  ok(Array.isArray(points), 'forkPoints 返回数组')
  if (points.length) {
    ok(typeof points[0].entryId === 'string' && points[0].entryId.length > 0, '分叉点带 entryId')
    ok(typeof points[0].text === 'string', '分叉点带 text')
  }

  /* ================= 7.5 新建会话后左栏有反应 ================= */
  log('\n--- 7.5 新建会话的可见性 ---')
  await store.getState().newSession()
  await sleep(2500)
  await store.getState().refreshSessions()
  await sleep(800)

  const s = store.getState().session
  log('  sessionName=' + JSON.stringify(s?.sessionName))
  log('  sessionFile=' + JSON.stringify(s?.sessionFile))

  // pi 的会话文件是**懒创建**的：空会话不落盘，所以 sessions 列表里没有它。
  // 左栏必须为当前会话补一条合成条目，否则点「新对话」用户看不到任何反馈。
  const onDisk = store.getState().sessions.some((x) => x.path === s?.sessionFile)
  log('  文件已落盘: ' + onDisk)

  const railItems = qa('.rail .srow')
  const selItem = q('.rail .srow.sel')
  ok(railItems.length > 0, `左栏渲染了 ${railItems.length} 条`)
  ok(!!selItem, '左栏有一条「当前会话」被选中')
  if (selItem) {
    log('  选中项: ' + JSON.stringify(selItem.querySelector('.srow-name')?.textContent))
    ok(
      selItem.querySelector('.srow-name')?.textContent === (s?.sessionName ?? '未命名'),
      '选中项标题 = 会话名（没名字时显示「未命名」）'
    )
  }

  // 给它起个名字，左栏应立刻跟上
  const NEWNAME = 'yan-visibility-' + Date.now().toString(36)
  await store.getState().renameSession(NEWNAME)
  await sleep(1200)
  const namedRail = qa('.rail .srow-name').map((e) => e.textContent)
  ok(namedRail.includes(NEWNAME), `改名后左栏出现 ${JSON.stringify(NEWNAME)}`)

  /* ================= 8. 溢出回归 ================= */
  log('\n--- 8. 溢出回归 ---')
  store.getState().closeSettings()
  await sleep(300)
  for (const sel of ['.rail-body', '.stream', '.app']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  return out.join('\n')
})()
