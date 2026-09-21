/**
 * 旧任务扩展与砚**同时存在**（实施-02 S1 · 兼容性与契约定稿）。
 *
 * 场景前提：专属 piDir 里放了一份 fixture 旧扩展（`scripts/fixtures/task-ext`），
 * 它注册同名 `panel_todos`、写旧标识 `left-panel-tasks`、注册 `/panel` 命令，
 * 并在 `session_start` 发一条 TUI 风格的通知 —— 与用户本机那份的关键行为一致。
 *
 * 这一片**不要求 UI 已经改好**（`/panel` 的反馈与草稿保留是 S4）。
 * 它要做的是把「两套来源同时存在时实际发生了什么」记录下来，并钉住两条底线：
 *   · 砚**只读**旧条目，不写、不转换、不伪造任务调用；
 *   · 旧扩展的写入与砚的读取**不互相覆盖**（宿主不碰旧标识）。
 * 所以第 4 节对 `/panel` 的现状是**记录**，硬断言只钉「没有当自然语言发出去」——
 * S4 改完之后这条断言仍然成立（那时草稿还会留着），不会变成假红。
 *
 * S5 把 piDir 扩成**两个扩展**（旧任务扩展 + 一个与任务无关的）：
 * 诊断计数、命令列表、清单来源判定都可能被无关扩展影响，只放一个验不出来。
 *
 * 另外解释一下为什么不在这里验「旧 JSONL 逐字节」：那要等 Electron 退出，
 * 由 `afterExit: taskFixtureReadonly` 在 Node 侧比（见 test-live.mjs）。
 */
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

    log('=== 旧任务扩展共存：行为记录（实施-02 S1）===')

    /* ================= 1. 启动期：通知降级 + 来源诊断 ================= */
    log('\n--- 1. 启动期通知与来源诊断 ---')
    await until(() => store.getState().conn === 'ready', 20000)
    const logs = () => store.getState().logs
    const notices = () => store.getState().notices

    const extNotify = logs().filter((l) => l.includes('信息面板已启用'))
    log('  扩展 notify 落日志: ' + extNotify.length + (extNotify[0] ? ' → ' + JSON.stringify(extNotify[0].slice(0, 70)) : ''))
    ok(extNotify.length > 0, '旧扩展真的被 pi 加载了（它的 session_start 通知进了日志）')
    ok(
      !notices().some((n) => (n.text ?? '').includes('信息面板已启用')),
      '启动期通知没有弹成浮层（TUI 措辞不该打断桌面端）'
    )

    /*
     * 来源诊断是本片新增的「诊断样例」：出问题时（清单跳变 / 历史对不上）
     * 第一件事就是分辨是谁写的。没有这几行就只能靠猜。
     */
    const userLine = logs().find((l) => l.includes('[来源] 用户扩展'))
    const thinLine = logs().find((l) => l.includes('[来源] 砚内置薄层'))
    log('  来源诊断（用户）: ' + JSON.stringify(userLine ?? null))
    log('  来源诊断（薄层）: ' + JSON.stringify(thinLine ?? null))
    ok(!!userLine, '诊断里有「用户扩展」清单')
    ok(!!userLine && userLine.includes('left-info-panel.ts'), '清单里点出了具体扩展名')
    /*
     * S5：诊断计的是**全部**用户扩展，不是只挑跟任务有关的那一个。
     * 这一条能红的场景是真存在的：按名字/关键词过滤扩展时，
     * 无关扩展会从清单里消失，用户就以为它没被加载。
     */
    ok(!!userLine && /2 项/.test(userLine), '诊断数的是全部用户扩展（实际 2 项）', userLine ? '' : '（缺诊断行）')
    ok(
      !!userLine && userLine.includes('notes-panel.ts'),
      '与任务无关的那份扩展也在清单里（没有被任务逻辑过滤掉）'
    )
    const notesNotify = logs().filter((l) => l.includes('笔记面板已启用'))
    log('  无关扩展 notify 落日志: ' + notesNotify.length)
    ok(notesNotify.length > 0, '无关扩展真的被加载且跑到了 session_start')
    ok(!!thinLine, '诊断里有「砚内置薄层」清单')
    const taskLine = logs().find((l) => l.includes('left-panel-tasks'))
    ok(!!taskLine, '诊断说明了旧任务条目的只读语义', taskLine ? '' : '（缺这句话，用户无法判断两套清单的关系）')

    /* ================= 2. pi 侧确实加载了旧扩展 ================= */
    log('\n--- 2. pi 侧加载证据 ---')
    await until(() => store.getState().commands.length > 0, 10000)
    const panelAll = store.getState().commands.filter((c) => c.name.toLowerCase() === 'panel')
    const panelFromExt = panelAll.find((c) => c.source === 'extension')
    log('  commands 里的 panel: ' + JSON.stringify(panelFromExt ?? panelAll[0] ?? null))
    log('  同名 panel 条数: ' + panelAll.length + ' → ' + JSON.stringify(panelAll.map((c) => c.source)))
    /*
     * 必须能看到 **extension 来源**的那条：本地兼容表里也有一条 panel
     * （`compatibility`，不可执行）。只看「有 panel 这个名字」会把本地那条
     * 当证据 —— 那证明不了旧扩展真的被加载了。
     */
    ok(!!panelFromExt, 'pi 把旧扩展注册的 /panel 报了上来（source=extension）')
    ok(panelAll.length >= 2, '同名命令没有被静默吞掉（兼容项与扩展项都在）')
    /* S5：无关扩展的命令也照常报上来（砚不因为迁移任务就吞掉别的扩展） */
    const notesAll = store.getState().commands.filter((c) => c.name.toLowerCase() === 'notes')
    log('  commands 里的 notes: ' + JSON.stringify(notesAll.map((c) => c.source)))
    ok(
      notesAll.some((c) => c.source === 'extension'),
      '无关扩展注册的 /notes 照常可用（source=extension）'
    )

    /* ================= 3. 任务清单来自会话文件（只读） ================= */
    log('\n--- 3. 共存时的任务清单来源 ---')
    /* 前置场景可能刚改过会话标题 / 视图；先拿一次主进程索引，避免在
     * 旧的渲染投影里选到目标但随后读的是上一条会话的任务状态。 */
    await store.getState().refreshSessions?.()
    const sessionRows = store.getState().sessions
    const target = sessionRows.find((s) => s.path.includes('yan-todo-fixture') || s.title.includes('YAN-TODO'))
    if (!target) {
      log('  ✗ fixture 里没有带任务的会话 —— 场景前提不成立')
      return out.join('\n')
    }
    /*
     * 身份与内容分两步确认：切会话时旧 runner 的 runtime 推送可能迟到，
     * 只等 `todos` 会读到上一条投影的中间态（全量运行中确实撞到过一次）。
     * 全量批次还可能让第一次选择落在迟到帧上；最多重走两次同一个稳定路径，
     * 不放宽断言，也不接受“看起来像任务”的其它会话。
     */
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
    /*
     * 内容必须是**会话文件里**那份：探针没有调用任何任务工具，
     * 所以这些文字只可能来自宿主对 `get_entries` 的只读解析。
     */
    ok(
      todos[0]?.text === '读 spec 并确认范围' && todos[1]?.text === '写 protocol.ts 的 JSONL 分帧',
      '清单内容与会话文件一致（宿主只读解析，不是扩展内存）'
    )

    const gotHistory = await until(() => (store.getState().todoHistory?.length ?? 0) >= 1, 8000)
    const hist = store.getState().todoHistory
    log('  todo-history 份数: ' + (hist?.length ?? 0))
    ok(gotHistory, '历史快照也读得到（旧条目不被当成新格式丢弃）')

    /* ================= 4. /panel 的当前行为（基线，S4 修） ================= */
    log('\n--- 4. 手打 /panel 的当前行为（S1 记录基线） ---')
    const msgsBefore = store.getState().messages.length
    const noticesBefore = notices().length
    if (!ta()) {
      log('  ⤺ 跳过：找不到输入框')
    } else {
      setVal(ta(), '/panel')
      await sleep(300)
      /*
       * 先 Escape 关掉斜杠补全菜单再回车。
       * 不关的话 Enter 会被菜单消费成「填入命令 + 尾空格」，根本没走到提交路径 ——
       * 实测第一版就是这样：草稿变成 `/panel `，看起来像「保留了草稿」，其实什么也没测。
       * Escape 必须派发到 **textarea**（菜单的按键处理挂在输入框上，document 收不到）。
       */
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
      /*
       * 这条是**硬断言**（两个阶段都成立）：/panel 是 TUI 命令，
       * 无论 UI 怎么处理，都不能被当成自然语言发给模型 —— 模型看不见
       * TUI 的 overlay，收到这五个字符只会瞎猜。
       */
      ok(!sent, '/panel 没有被当成自然语言发出去')
      /* 下面两条是 S1 的现状记录：S4 的目标是「草稿与附件都留着 + 有明确反馈」。 */
      log('  （记录）草稿是否被清空：' + (draft.trim() === '' ? '被清空' : '仍保留'))
      log('  （记录）是否给了反馈：' + (notices().length > noticesBefore ? '有' : '无'))
    }

    /* ================= 5. 不串会话 ================= */
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
