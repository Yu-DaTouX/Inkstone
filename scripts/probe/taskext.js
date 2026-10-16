;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s, extra = '') => out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const ta = () => document.querySelector('textarea')
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = document.querySelector('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(300)
      } else await sleep(150)
    }

    log('=== 带历史扩展目录：原生发现与只读历史 ===')

    log('\n--- 1. 启动期通知与来源诊断 ---')
    await until(() => store.getState().conn === 'ready', 20000)
    const version = store.getState().piInfo?.version?.split('.').map(Number)
    const nativeDiscovery = !!version && (version[0] > 0 || version[1] >= 99)
    log('  pi version: ' + store.getState().piInfo?.version + '; nativeDiscovery=' + nativeDiscovery)
    const logs = () => store.getState().logs
    const notices = () => store.getState().notices

    const extNotify = logs().filter((l) => l.includes('信息面板已启用'))
    log('  扩展 notify 落日志: ' + extNotify.length + (extNotify[0] ? ' → ' + JSON.stringify(extNotify[0].slice(0, 70)) : ''))
    ok(nativeDiscovery ? extNotify.length > 0 : extNotify.length === 0, '任务扩展启动通知符合当前 pi 发现策略')
    ok(
      !notices().some((n) => (n.text ?? '').includes('信息面板已启用')),
      '启动期通知没有弹成浮层（TUI 措辞不该打断桌面端）'
    )

    const userLine = logs().find((l) => l.includes('[来源] 用户扩展'))
    const thinLine = logs().find((l) => l.includes('[来源] 砚内置薄层'))
    log('  来源诊断（用户）: ' + JSON.stringify(userLine ?? null))
    log('  来源诊断（薄层）: ' + JSON.stringify(thinLine ?? null))
    ok(!!userLine, '诊断里有「用户扩展」清单')
    ok(!!userLine && userLine.includes('left-info-panel.ts'), '清单里点出了具体扩展名')
    ok(!!userLine && (nativeDiscovery
      ? userLine.includes('由 pi 原生发现') && !userLine.includes('--no-extensions') && userLine.includes('目录清单不代表已加载')
      : userLine.includes('--no-extensions') && userLine.includes('不自动加载')), '来源诊断与当前 runner 的发现策略一致')
    ok(!!userLine && /2 项/.test(userLine), '诊断数的是全部用户扩展（实际 2 项）', userLine ? '' : '（缺诊断行）')
    ok(
      !!userLine && userLine.includes('notes-panel.ts'),
      '与任务无关的那份扩展也在清单里（没有被任务逻辑过滤掉）'
    )
    const notesNotify = logs().filter((l) => l.includes('笔记面板已启用'))
    log('  无关扩展 notify 落日志: ' + notesNotify.length)
    ok(nativeDiscovery ? notesNotify.length > 0 : notesNotify.length === 0, '无关扩展启动通知也符合发现策略')
    ok(!!thinLine, '诊断里有「砚内置薄层」清单')
    const taskLine = logs().find((l) => l.includes('left-panel-tasks'))
    ok(!!taskLine, '诊断说明了旧任务条目的只读语义', taskLine ? '' : '（缺这句话，用户无法判断两套清单的关系）')

    log('\n--- 2. pi 侧默认发现边界 ---')
    await until(() => store.getState().commands.length > 0, 10000)
    const panelAll = store.getState().commands.filter((c) => c.name.toLowerCase() === 'panel')
    const panelFromExt = panelAll.find((c) => c.source === 'extension')
    log('  commands 里的 panel: ' + JSON.stringify(panelFromExt ?? panelAll[0] ?? null))
    log('  同名 panel 条数: ' + panelAll.length + ' → ' + JSON.stringify(panelAll.map((c) => c.source)))
    ok(nativeDiscovery ? !!panelFromExt : !panelFromExt, '/panel 的扩展来源符合实际发现策略')
    ok(panelAll.some((c) => c.source === 'extension') === nativeDiscovery, '当前 runner 命令来源没有误判目录存在')
    const notesAll = store.getState().commands.filter((c) => c.name.toLowerCase() === 'notes')
    log('  commands 里的 notes: ' + JSON.stringify(notesAll.map((c) => c.source)))
    ok(
      nativeDiscovery ? notesAll.some(c => c.source === 'extension') : notesAll.length === 0,
      '无关扩展 /notes 的来源也符合实际发现策略'
    )

    log('\n--- 3. 默认不加载时的历史任务清单来源 ---')
    await store.getState().refreshSessions?.()
    const sessionRows = store.getState().sessions
    const target = sessionRows.find((s) => s.path.includes('yan-todo-fixture') || s.title.includes('YAN-TODO'))
    if (!target) {
      log('  ✗ fixture 里没有带任务的会话 —— 场景前提不成立')
      return out.join('\n')
    }
    let targetReady = false
    let tasksReady = false
    for (let attempt = 0; attempt < 3 && !tasksReady; attempt++) {
      if (attempt > 0) await store.getState().refreshSessions?.()
      await store.getState().switchSession(target.path)
      targetReady = await until(() => store.getState().session?.sessionFile === target.path, 10000)
      tasksReady = await until(
        () => targetReady && store.getState().session?.sessionFile === target.path && store.getState().todos.length === 4,
        10000
      )
    }
    const todos = store.getState().todos
    log('  todos = ' + JSON.stringify(todos.map((t) => t.text)))
    ok(todos.length === 4, `读到 fixture 会话里的 4 条（实际 ${todos.length}）`)
    ok(
      todos[0]?.text === '读 spec 并确认范围' && todos[1]?.text === '写 protocol.ts 的 JSONL 分帧',
      '清单内容与会话文件一致（宿主只读解析，不是扩展内存）'
    )

    const gotHistory = await until(() => (store.getState().todoHistory?.length ?? 0) >= 1, 8000)
    const hist = store.getState().todoHistory
    log('  todo-history 份数: ' + (hist?.length ?? 0))
    ok(gotHistory, '历史快照也读得到（旧条目不被当成新格式丢弃）')

    log('\n--- 4. 手打 /panel 的当前行为（S1 记录基线） ---')
    const msgsBefore = store.getState().messages.length
    const noticesBefore = notices().length
    if (!ta()) {
      log('  ⤺ 跳过：找不到输入框')
    } else {
      setVal(ta(), '/panel')
      await sleep(300)
      key(ta(), 'Escape')
      await until(() => !document.querySelector('.slash-menu'), 2000)
      log('  斜杠菜单已关：' + (document.querySelector('.slash-menu') ? '否（Enter 会被它吃掉）' : '是'))
      const draftBeforeEnter = ta()?.value ?? ''
      key(ta(), 'Enter')
      await sleep(800)
      const draft = ta()?.value ?? '<没有输入框>'
      const msgsAfter = store.getState().messages.length
      const userTexts = store
        .getState()
        .messages.filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
      const sent = userTexts.some((t) => t.includes('/panel'))
      log('  回车前草稿 = ' + JSON.stringify(draftBeforeEnter.slice(0, 40)))
      log('  回车后草稿 = ' + JSON.stringify(draft.slice(0, 40)))
      log('  消息数 ' + msgsBefore + ' → ' + msgsAfter + '；通知 ' + noticesBefore + ' → ' + notices().length)
      ok(!sent, '/panel 没有被当成自然语言发出去')
      log('  （记录）草稿是否被清空：' + (draft.trim() === '' ? '被清空' : '仍保留'))
      log('  （记录）是否给了反馈：' + (notices().length > noticesBefore ? '有' : '无'))
    }

    log('\n--- 5. 切走之后不残留 ---')
    const other = store.getState().sessions.find((s) => s.path !== target.path)
    if (!other) {
      log('  （只有一个会话，跳过）')
    } else {
      await store.getState().switchSession(other.path)
      const otherReady = await until(() => store.getState().session?.sessionFile === other.path, 15000)
      await until(() => otherReady && store.getState().todos.length === 0, 15000)
      ok(otherReady && store.getState().todos.length === 0, '切到别的会话后清单清空（不拿上一个会话的残留冒充）')
    }

    return out.join('\n')
  } catch (e) {
    out.push('✗ 探针异常：' + (e && e.stack ? e.stack : String(e)))
    return out.join('\n')
  }
})()
