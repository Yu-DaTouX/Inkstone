;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s, extra = '') => out.push((cond ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const ta = () => document.querySelector('textarea')
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const roundRunning = () => !!store.getState()?.session?.isAgentRunning

  const runTurn = async (text, budget = 150000) => {
    if (!ta()) throw new Error('找不到输入框')
    setVal(ta(), text)
    await sleep(150)
    const send = q('[data-testid="send"]')
    if (!send || send.disabled) throw new Error('发送键不可用')
    click(send)
    const t0 = Date.now()
    let started = false
    while (Date.now() - t0 < budget) {
      await sleep(400)
      if (roundRunning()) started = true
      if (started && !roundRunning() && !q('.trow[data-state="running"]')) {
        await sleep(900)
        return true
      }
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

    log('=== 宿主任务服务：`yan tasks apply` → 界面清单（实施-02 S3）===')

    await until(() => store.getState().conn === 'ready', 20000)

    const sess = () => store.getState().session
    const originPath = sess()?.sessionFile ?? ''
    const originId = sess()?.sessionId ?? ''
    log(`  起始会话：${originId}（${originPath || '路径未知'}）`)
    const brief = (p) => String(p ?? '').split(/[\\/]/).pop() ?? '-'
    const snap = (label) => {
      const s = sess()
      log(
        `  [${label}] id=${s?.sessionId ?? '-'} file=${brief(s?.sessionFile)} todos=${store.getState().todos.length}`
      )
    }
    snap('起始')

    log('\n--- 1. set（模型 → bash → yan → 宿主日志）---')
    const ran1 = await runTurn(
      '请严格按下面两步执行，不要跳过、不要自己编造输出：\n' +
        '1. 调用 bash 工具执行这条命令（文件已经存在，不要修改它）：\n' +
        '   yan tasks apply --request-file tasks/task-set.json\n' +
        '2. 把命令输出里的 operationId 与 summary 字段原样贴出来。'
    )
    ok(ran1, '第一个回合跑完了')
    await until(() => store.getState().todos.length > 0, 12000)
    snap('第 1 轮后')

    const todos1 = store.getState().todos
    log('  todos = ' + JSON.stringify(todos1.map((t) => ({ text: t.text, done: t.done }))))
    qa('.tgroup-fold[aria-expanded="false"]').forEach((h) => click(h))
    await sleep(500)
    const assistantText = store
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    log('  工具行 / 工具组：' + qa('.trow').length + ' / ' + qa('.tgroup').length)
    log('  工具名：' + JSON.stringify([...new Set(qa('.trow').map((r) => r.dataset.tool))]))
    log('  最近助手回复：' + JSON.stringify(assistantText.slice(-400)))
    log(
      '  消息尾部：' +
        JSON.stringify(
          store
            .getState()
            .messages.slice(-3)
            .map((m) => ({
              role: m.role,
              text: (typeof m.content === 'string' ? m.content : '').slice(0, 80),
              tools: (m.toolCalls ?? []).map((t) => t.name)
            }))
        )
    )
    log('  日志尾部：' + JSON.stringify((store.getState().logs ?? []).slice(-5)))
    const planCalls = store
      .getState()
      .messages.flatMap((m) => m.toolCalls ?? [])
      .filter((c) => typeof c.args?.command === 'string' && /tasks\s+apply/i.test(c.args.command))
    log(
      '  tasks apply 调用 ' +
        planCalls.length +
        ' 次，尾部：' +
        JSON.stringify(
          planCalls.slice(-2).map((c) => ({
            status: c.status,
            out: (typeof c.output === 'string' ? c.output : '').slice(-400)
          }))
        )
    )
    ok(todos1.length === 3, `界面上出现 3 条任务（实际 ${todos1.length}）`)
    ok(
      todos1[0]?.text === '确认范围' && todos1[2]?.text === '真实运行验收',
      '条目文字与 request 文件一致（不是模型自己编的清单）'
    )
    ok(
      await until(() => (store.getState().todoHistory?.length ?? 0) >= 1, 8000),
      '历史快照 ≥ 1 份'
    )

    const body1 = document.body.innerText || ''
    const missingCmd = body1.match(/[^\n]{0,60}(yan[^\n]{0,60}(不是内部或外部命令|command not found|not recognized|No such file)|(不是内部或外部命令|command not found|not recognized)[^\n]{0,60}yan)[^\n]{0,60}/i)
    ok(!missingCmd, 'yan 没有被当成找不到的命令（启动器 + PATH 注入在这条链路上也生效）', missingCmd ? JSON.stringify(missingCmd[0]) : '')
    const bashRows = qa('.trow[data-tool="bash"]')
    ok(
      bashRows.length >= 1,
      `有 bash 工具行（${bashRows.length} 条）—— 真实底层是 bash，不是伪造的原生任务工具`
    )
    const bashTarget = bashRows
      .map((r) => r.querySelector('.trow-target')?.textContent ?? '')
      .join(' | ')
    log('  bash 工具行摘要：' + JSON.stringify(bashTarget.slice(0, 200)))
    ok(bashTarget.includes('task-set.json'), '工具行显示的就是指定那条命令（工具调用与预期一致）')

    const originRows = qa('.trow[data-origin="yan-task-plan"]')
    log('  标记为任务计划的工具行：' + originRows.length + ' 条')
    ok(originRows.length >= 1, '至少一条工具行被标为砚内置任务计划')
    ok(
      originRows.every((r) => r.dataset.tool === 'bash'),
      '标记的仍然是 bash 卡（不伪造原生独立工具事件）'
    )
    const originBadge = originRows[0]?.querySelector('[data-testid="tool-src"]')?.textContent ?? ''
    log('  来源徐标：' + JSON.stringify(originBadge))
    ok(/任务计划/.test(originBadge), '徐标写明「任务计划」')
    if (originRows[0]) {
      click(originRows[0].querySelector('.trow-head'))
      await sleep(500)
      const bodyText = originRows[0].querySelector('.trow-body')?.innerText ?? ''
      ok(bodyText.includes('task-set.json'), '展开后能看到原始命令（可查参数与错误）')
      click(originRows[0].querySelector('.trow-head'))
      await sleep(300)
    }
    log('  （记录）模型有没有把摘要贴回正文：' + (/task-plan|revision/.test(body1) ? '有' : '无'))

    log('\n--- 2. complete（第二次提交）---')
    const histBefore = store.getState().todoHistory?.length ?? 0
    const bashBefore = qa('.trow[data-tool="bash"]').length
    const ran2 = await runTurn(
      '再用 bash 工具执行一条命令，不要跳过：\n' +
        '  yan tasks apply --request-file tasks/task-complete.json\n' +
        '执行完把命令输出原样贴出来。',
      150000
    )
    ok(ran2, '第二个回合跑完了')
    const bashAfter = qa('.trow[data-tool="bash"]').length
    log(`  bash 工具行：${bashBefore} → ${bashAfter}`)
    ok(bashAfter > bashBefore, '第二个回合真的又敲了一次命令（不是光嘴上说完成）')
    const target2 = qa('.trow[data-tool="bash"]')
      .map((r) => r.querySelector('.trow-target')?.textContent ?? '')
      .join(' | ')
    ok(target2.includes('task-complete.json'), '第二次工具行也是指定那条命令')
    const ticked = await until(() => store.getState().todos[1]?.done === true, 12000)
    const assistant2 = store
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    ok(ticked, '第 2 项在界面上被勾上', ticked ? '' : '回复尾部：' + JSON.stringify(assistant2.slice(-200)))
    snap('第 2 轮后')

    const todos2 = store.getState().todos
    log('  todos = ' + JSON.stringify(todos2.map((t) => ({ text: t.text, done: t.done }))))
    ok(todos2.length === 3, '清单仍是 3 条（complete 不改数量）')
    const grew = await until(() => (store.getState().todoHistory?.length ?? 0) > histBefore, 8000)
    const histAfter = store.getState().todoHistory?.length ?? 0
    ok(grew, `历史快照从 ${histBefore} 份增到 ${histAfter} 份（第二次提交真的留了记录）`)

    log('\n--- 3. 切会话不串数据 / 切回来读得回 ---')
    const other = store.getState().sessions.find((s) => s.path !== originPath)
    if (!other || !originPath) {
      log('  ⤺ 跳过：没有第二条会话可切（场景前提不足）')
    } else {
      await store.getState().switchSession(other.path)
      await until(() => store.getState().todos.length === 0, 15000)
      snap('切到别的会话后')
      ok(store.getState().todos.length === 0, '切到别的会话后清单为空（不拿别的会话的清单冒充）')

      await store.getState().switchSession(originPath)
      const settled = await until(
        () => store.getState().session?.sessionId === originId && store.getState().todos.length === 3,
        15000
      )
      snap('切回后')
      ok(settled, '切回原会话并稳定在原 id（不是临时会话）')
      await sleep(1500)
      snap('切回 +1.5s')
      const back = store.getState().todos
      log('  切回后 todos = ' + JSON.stringify(back.map((t) => ({ text: t.text, done: t.done }))))
      ok(back.length === 3, '切回原会话后清单从磁盘读回（3 项）')
      ok(back[1]?.done === true, '完成状态一起读回（不是上一个会话的内存残留）')
      ok(
        store.getState().session?.sessionId === originId,
        '取证行里的会话 id 就是原会话（后面退出后按它找日志）'
      )
    }

    log('\n--- 4. 取消一个正在跑的回合 ---')
    const todosBeforeCancel = JSON.stringify(store.getState().todos)
    if (!ta()) {
      log('  ⤺ 跳过：找不到输入框')
    } else {
      setVal(ta(), '请从 1 数到 200，每个数字单独一行，不要省略、不要概括。')
      await sleep(200)
      const sendBtn = q('[data-testid="send"]')
      if (!sendBtn || sendBtn.disabled) {
        log('  ⤺ 跳过：发送键不可用')
      } else {
        click(sendBtn)
        const started = await until(() => roundRunning(), 30000)
        ok(started, '取消前回合真的跑起来了')
        if (started) {
          const stopBtn = q('[data-testid="send"]')
          log('  同一个按钮此时的文案：' + JSON.stringify(stopBtn?.textContent ?? ''))
          click(stopBtn)
          const stopped = await until(() => !roundRunning(), 25000)
          ok(stopped, '取消生效（回合停下）')
          await sleep(1200)
          const afterCancel = JSON.stringify(store.getState().todos)
          log('  取消后清单：' + afterCancel)
          ok(afterCancel === todosBeforeCancel, '取消没有改动任务清单（不丢数据、不误写）')
          ok(!q('.trow[data-state="running"]'), '没有卡在「运行中」的工具行')
          const taAfter = ta()
          ok(!!taAfter && !taAfter.disabled, '取消后输入框仍可用')
        }
      }
    }

    const sessionList = store.getState().sessions.map((s) => `${s.id}=${brief(s.path)}`)
    log('  会话列表：' + JSON.stringify(sessionList))
    log(`taskcli.sessionId=${store.getState().session?.sessionId ?? ''}`)
    log(`taskcli.sessionFile=${store.getState().session?.sessionFile ?? ''}`)
    log(`taskcli.todos=${JSON.stringify(store.getState().todos)}`)
    return out.join('\n')
  } catch (e) {
    return fail('探针异常：' + (e && e.stack ? e.stack : String(e)))
  }
})()
