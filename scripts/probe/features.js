;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const skip = (s) => {
    out.push('  ⤺ 跳过：' + s)
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
  try {

  const store = window.__yanStore
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return fn()
  }

  const ensureClosed = async () => {
    if (window.__yanStore.getState().settingsOpen) {
      window.__yanStore.getState().closeSettings()
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  const connNow = store.getState().conn
  log('pi 连接: ' + connNow)
  if (connNow !== 'ready') {
    return skip(`pi 未就绪（conn=${connNow}），本场景要发真实消息`)
  }

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
    keydown(ta, 'ArrowDown')
    await sleep(80)
    ok(q('.slash-item.sel') === qa('.slash-item')[1] || qa('.slash-item').length === 1, '方向键切换选中项')
    keydown(ta, 'Enter')
    await sleep(150)
    ok(ta.value.startsWith('/') && ta.value.length > 1, `Enter 补全为 ${JSON.stringify(ta.value)}`)
    ok(!q('.slash-menu'), '补全后菜单收起')
  }
  setVal(ta, '')
  await sleep(100)

  log('\n--- 2. ! 直执行 bash（不进模型）---')
  await ensureClosed()
  const nBefore = qa('.msg').length
  setVal(ta, '!echo yan-bash-feature-ok')
  await sleep(200)
  ok(!!q('.mode-badge.bash'), '出现 bash 模式角标')
  const bashSendBtn = q('[data-testid="send"]')
  ok(bashSendBtn.textContent.includes('执行'), '发送键变成「执行」')

  click(bashSendBtn)

  let bashDone = false
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const fold = q('.msg.bash [data-testid="tool-group-toggle"]')
    if (fold && fold.getAttribute('aria-expanded') === 'false') click(fold)
    const t = q('.msg.bash .trow')
    if (t && t.dataset.state !== 'running' && t.dataset.state !== 'pending') {
      bashDone = true
      break
    }
  }
  await sleep(600)

  const bashMsg = q('.msg.bash')
  ok(!!bashMsg, '产生了 bash 消息')
  if (!bashDone) log('  bash DOM: ' + (q('.msg.bash')?.innerHTML || '').slice(0, 900))
  ok(bashDone, '命令执行完毕（状态不再是 running）')
  if (bashMsg) {
    const row = bashMsg.querySelector('.trow')
    ok(!!row, '是新的一行式工具行（.trow）')
    if (row) {
      const head = row.querySelector('.trow-head')
      if (!row.classList.contains('open') && head) head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(300)
      const outText = bashMsg.textContent ?? ''
      log('  输出片段: ' + JSON.stringify(outText.replace(/s+/g, ' ').slice(0, 80)))
      ok(outText.includes('yan-bash-feature-ok'), '展开后能看到命令打印的内容')
      ok(row.getAttribute('data-state') === 'ok', '状态为成功')
    }
  }
  ok(qa('.msg').length > nBefore, '消息数增加')
  ok(store.getState().session?.isStreaming !== true, '没有进入「模型流式」状态（确实绕过了模型）')

  setVal(ta, '!exit 3')
  await sleep(150)
  click(q('[data-testid="send"]'))
  for (let i = 0; i < 100; i++) {
    await sleep(300)
    const t = qa('.msg.bash .trow').pop()
    if (t && t.dataset.state !== 'running' && t.dataset.state !== 'pending') break
  }
  await sleep(400)
  const lastBash = qa('.msg.bash').pop()
  if (lastBash) {
    const card = lastBash.querySelector('.trow')
    if (card) {
      ok(card.dataset.state === 'error', `非零退出码标记为失败（data-state=${card.dataset.state}）`)
    } else {
      ok(false, '找不到工具行（.trow）')
    }
  }

  log('\n--- 3. 图片附件 ---')
  await ensureClosed()
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

  if (attach.length) {
    click(attach[0].querySelector('.attach-del'))
    await sleep(300)
    ok(store.getState().attachments.length === 0, '点 ✕ 能移除附件')
    ok(!q('.attach'), '缩略图已消失')
  }

  store.getState().addAttachments([
    { id: 'a1', name: 'dup.png', mimeType: 'image/png', size: 10, data: b64, preview: b64 },
    { id: 'a2', name: 'dup.png', mimeType: 'image/png', size: 10, data: b64, preview: b64 }
  ])
  await sleep(150)
  ok(store.getState().attachments.length === 1, '同名同大小去重')
  store.getState().clearAttachments()
  await sleep(100)

  log('\n--- 4. 模型 / 思考选择器 ---')
  await ensureClosed()
  const picker = q('[data-testid="model-picker"]')
  ok(!!picker, '输入栏有统一模型菜单入口')
  if (picker) {
    click(picker)
    await until(() => !!q('[data-testid="model-menu"]'), 3000)
    click(q('[data-testid="models-provider"]'))
    if (await until(() => !!q('.ui-choice-menu [data-value=""]'), 2000)) {
      click(q('.ui-choice-menu [data-value=""]'))
      await sleep(200)
    }
    await until(() => qa('[data-testid="model-option"]').length > 1 || !!q('[data-testid="models-empty"]'), 25000)
    const items = qa('[data-testid="model-option"]')
    const current = q('[data-testid="model-option"][data-current="1"]')
    const empty = q('[data-testid="models-empty"]')
    if (items.length === 0 && empty) {
      out.push(`  ~ 跳过：模型菜单为空（合成模式无凭证/模型目录），空态文案 = ${JSON.stringify((empty.textContent ?? '').trim())}`)
    } else {
      ok(items.length > 1, `模型菜单有 ${items.length} 个模型`)
      ok(!!current, '模型菜单标记当前模型')
    }
    const thinkButtons = qa('[data-testid^="thinking-dot-"]')
    const capNote = q('[data-testid="thinking-capability-status"]')
    const thinkSection = q('[data-testid="thinking-current"]')
    const levels = store.getState().thinkingLevels
    if (levels.length > 1) {
      ok(thinkButtons.length > 0, `多档时出档位按钮（${thinkButtons.length} 个 / levels=${levels.length}）`)
    } else {
      ok(!thinkSection || !!capNote, `单档或能力未知时整块不渲染（levels=${JSON.stringify(levels)}）`)
    }

    const cur = store.getState().session?.model
    const other = items.find((el) => el.getAttribute('data-current') !== '1')
    if (other) {
      click(other)
      await sleep(1200)
      const id = other.dataset.modelId ?? ''
      ok(store.getState().session?.model?.id === id, `菜单切换到 ${id} 生效`)
      if (cur) {
        await store.getState().setModel(cur.provider, cur.id)
        await sleep(1200)
        ok(store.getState().session?.model?.id === cur.id, '切回原模型成功')
      }
    }

    if (!q('[data-testid="model-menu"]')) { click(picker); await sleep(200) }
    const thinkingDetails = q('[data-testid="model-thinking-settings"]')
    if (thinkingDetails instanceof HTMLDetailsElement && !thinkingDetails.open) {
      thinkingDetails.querySelector('summary')?.click()
    }
    const originalThinking = store.getState().session?.thinkingLevel ?? 'off'
    const thinkButtonsNow = qa('[data-testid^="thinking-dot-"]')
    const otherThink = thinkButtonsNow.find((el) => el.getAttribute('data-on') !== '1')
    if (otherThink) {
      const level = otherThink.getAttribute('data-level') ?? ''
      click(otherThink)
      let applied = false
      for (let i = 0; i < 25; i++) {
        if (store.getState().session?.thinkingLevel === level) {
          applied = true
          break
        }
        await sleep(200)
      }
      if (!applied) {
        const direct = await window.yan.setThinking(level)
        await sleep(600)
        log(
          `  [诊断] 点 ${level} 后等了 5s 仍是 ${JSON.stringify(store.getState().session?.thinkingLevel)}；` +
            `直接调主进程返回 ${JSON.stringify(direct)}；再读 store=${JSON.stringify(store.getState().session?.thinkingLevel)}`
        )
      }
      ok(applied, `菜单切到 ${level} 生效`)
      await store.getState().setThinking(originalThinking)
      let restored = false
      for (let i = 0; i < 25; i++) {
        if (store.getState().session?.thinkingLevel === originalThinking) {
          restored = true
          break
        }
        await sleep(200)
      }
      ok(restored, '切回原思考档成功')
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(250)
  }

  log('\n--- 5. 开关 ---')
  const contextTrigger = q('[data-testid="composer-context"]')
  ok(!!contextTrigger, '输入框提供上下文详情入口')
  if (contextTrigger && contextTrigger.getAttribute('aria-expanded') !== 'true') click(contextTrigger)
  const autoCompactReady = await until(() => !!q('[role="dialog"].ui-detail-popover [data-testid="rp-auto-compact"]'))
  ok(autoCompactReady, '打开上下文详情后显示自动压缩开关')
  const autoCompact = q('[role="dialog"].ui-detail-popover [data-testid="rp-auto-compact"]')
  if (autoCompact) {
    const before = store.getState().session?.autoCompactionEnabled
    log('  自动压缩当前: ' + before)
    const target = !before
    click(autoCompact)
    await until(() => store.getState().session?.autoCompactionEnabled === target, 5000)
    ok(
      store.getState().session?.autoCompactionEnabled === target,
      `切换后 autoCompactionEnabled = ${store.getState().session?.autoCompactionEnabled}（期望 ${target}）`
    )
    click(q('[role="dialog"].ui-detail-popover [data-testid="rp-auto-compact"]'))
    await until(() => store.getState().session?.autoCompactionEnabled === before, 5000)
    ok(store.getState().session?.autoCompactionEnabled === before, '还原成功')
  }
  if (q('[role="dialog"].ui-detail-popover')) {
    keydown(document.body, 'Escape')
    await until(() => !q('[role="dialog"].ui-detail-popover'))
  }

  const openSessionMenu = async () => {
    const trigger = q('[data-testid="session-menu"]')
    if (!trigger) return false
    if (!q('[data-testid="session-menu-popover"]')) click(trigger)
    return await until(() => !!q('[data-testid="session-menu-popover"]'))
  }
  const retryMenuReady = await openSessionMenu()
  ok(retryMenuReady, '会话菜单可打开')
  const autoRetry = q('[data-testid="session-menu-popover"] [data-testid="act-auto-retry"]')
  ok(!!autoRetry, '会话菜单提供自动重试开关')
  if (autoRetry) {
    const before = store.getState().autoRetryEnabled
    click(autoRetry)
    const menuClosed = await until(() => !q('[data-testid="session-menu-popover"]'))
    ok(menuClosed, '点击自动重试后会话菜单关闭')
    const toggled = await until(() => store.getState().autoRetryEnabled === !before, 5000)
    ok(toggled, '自动重试开关状态同步')

    const reopenForRestore = await openSessionMenu()
    ok(reopenForRestore, '恢复自动重试前重新打开会话菜单')
    const retryRestore = q('[data-testid="session-menu-popover"] [data-testid="act-auto-retry"]')
    ok(!!retryRestore, '重新打开后仍可找到自动重试菜单项')
    if (retryRestore && store.getState().autoRetryEnabled !== before) {
      click(retryRestore)
      const restoreClosed = await until(() => !q('[data-testid="session-menu-popover"]'))
      ok(restoreClosed, '恢复自动重试后会话菜单关闭')
    } else if (q('[data-testid="session-menu-popover"]')) {
      keydown(document.body, 'Escape')
    }
    const restored = await until(() => store.getState().autoRetryEnabled === before, 5000)
    ok(restored, '自动重试还原成功')
  }

  if (q('.app').classList.contains('rail-off')) click(q('[data-testid="rail-toggle"]'))
  const railOpen = await until(() => !q('.app').classList.contains('rail-off'))
  ok(railOpen, '左栏已展开（后续断言依赖它可见）')

  log('\n--- 6. 会话重命名 ---')
  await ensureClosed()
  const NAME = 'yan-rename-test-' + Date.now().toString(36)
  const origName = store.getState().session?.sessionName ?? ''

  await store.getState().renameSession(NAME)
  await sleep(1500)
  ok(store.getState().session?.sessionName === NAME, `会话名 = ${NAME}`)

  await store.getState().refreshSessions()
  await sleep(600)
  const railNames = qa('.rail .srow-name').map((e) => e.textContent)
  ok(
    railNames.includes(NAME) || !!q('.rail .srow.sel'),
    '左栏能看到这个名字（或当前会话条目）',
    JSON.stringify(railNames.slice(0, 3))
  )

  const restore = origName || '未命名'
  await store.getState().renameSession(restore)
  await sleep(1500)
  ok(
    store.getState().session?.sessionName === restore,
    `还原名字（现在 = ${JSON.stringify(store.getState().session?.sessionName)}）`
  )

  const emptyRes = await window.yan.renameSession('   ')
  ok(emptyRes.ok === false, '空名字被拒绝')
  ok(
    (emptyRes.error ?? '').length > 0,
    '空名字被拒时给出理由：' + JSON.stringify(emptyRes.error)
  )

  log('\n--- 7. 分叉点查询 ---')
  const points = await window.yan.forkPoints()
  log('  当前会话可分叉点: ' + points.length)
  ok(Array.isArray(points), 'forkPoints 返回数组')
  if (points.length) {
    ok(typeof points[0].entryId === 'string' && points[0].entryId.length > 0, '分叉点带 entryId')
    ok(typeof points[0].text === 'string', '分叉点带 text')
  }

  log('\n--- 7.5 新建会话的可见性 ---')
  await store.getState().newSession()
  await sleep(2500)
  await store.getState().refreshSessions()
  await sleep(800)

  const s = store.getState().session
  log('  sessionName=' + JSON.stringify(s?.sessionName))
  log('  sessionFile=' + JSON.stringify(s?.sessionFile))

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

  const NEWNAME = 'yan-visibility-' + Date.now().toString(36)
  await store.getState().renameSession(NEWNAME)
  await sleep(1200)
  const namedRail = qa('.rail .srow-name').map((e) => e.textContent)
  ok(namedRail.includes(NEWNAME), `改名后左栏出现 ${JSON.stringify(NEWNAME)}`)

  log('\n--- 8. 溢出回归 ---')
  store.getState().closeSettings()
  await sleep(300)
  for (const sel of ['.rail-body', '.stream', '.app']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  } catch (error) {
    out.push('  ✗ 探针异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
