;(async () => {
  const PROMPT = [
    '请完成一个三步任务，并且全程用砚的内置任务计划跟踪进度。严格按顺序做，不要跳步：',
    '',
    '任务：在 tasks/ 目录下依次创建 3 个文件：step-1.txt、step-2.txt、step-3.txt，',
    '每个文件里写一行你自己的说明（中文，一句话即可）。',
    '',
    '要求：',
    '1. 先用任务计划登记这 3 步。做法是先写一个请求文件（放在 tasks/ 下，名字自定），内容形状如下：',
    '   {"action":"add","items":[{"text":"第 1 步：…"},{"text":"第 2 步：…"},{"text":"第 3 步：…"}]}',
    '   然后执行： yan tasks apply --request-file <你写的请求文件>',
    '   三条文字里要能看出分别是第几步。',
    '2. 每创建完一个文件，就立刻用任务计划把它标为完成（index 从 0 开始，依次对应第 1、2、3 步）：',
    '   {"action":"complete","index":0}',
    '   然后执行： yan tasks apply --request-file <同一个请求文件>',
    '3. 三步都做完后，用一句话汇报结果。',
    '',
    '注意：不要跳过任务计划那几步，也不要提前把没做的步骤标成完成。'
  ].join('\n')

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

  const runTurn = async (text, budget = 300000) => {
    if (!ta()) throw new Error('找不到输入框')
    setVal(ta(), text)
    await sleep(200)
    const send = q('[data-testid="send"]')
    if (!send || send.disabled) throw new Error('发送键不可用')
    click(send)
    const t0 = Date.now()
    let started = false
    while (Date.now() - t0 < budget) {
      await sleep(400)
      if (roundRunning()) started = true
      if (started && !roundRunning() && !q('.trow[data-state="running"]')) {
        await sleep(1200)
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

    log('=== 真实多步任务：模型自主登记 / 执行 / 勾选（实施-02 S5）===')

    await until(() => store.getState().conn === 'ready', 20000)
    const sess = () => store.getState().session
    const originId = sess()?.sessionId ?? ''
    const originPath = sess()?.sessionFile ?? ''
    log(`  起始会话：${originId}（${String(originPath).split(/[\\/]/).pop() || '路径未知'}）`)

    log('\n--- 1. 模型自主跑一个三步任务 ---')
    const ran = await runTurn(PROMPT)
    ok(ran, '回合跑完了（模型自主多步）')

    await until(() => store.getState().todos.length > 0, 20000)

    qa('.tgroup-fold[aria-expanded="false"]').forEach((h) => click(h))
    await sleep(600)

    const calls = store.getState().messages.flatMap((m) => m.toolCalls ?? [])
    const names = calls.map((c) => c.name)
    log('  工具调用序列：' + JSON.stringify(names))
    const applyCalls = calls.filter(
      (c) => typeof c.args?.command === 'string' && /tasks\s+apply/i.test(c.args.command)
    )
    log('  tasks apply 调用 ' + applyCalls.length + ' 次')
    log(
      '  最近两条 apply：' +
        JSON.stringify(
          applyCalls.slice(-2).map((c) => ({
            ok: c.status,
            out: (typeof c.output === 'string' ? c.output : '').slice(-300)
          }))
        )
    )
    const assistantText = store
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    log('  助手回复尾部：' + JSON.stringify(assistantText.slice(-400)))
    log('  日志尾部：' + JSON.stringify((store.getState().logs ?? []).slice(-4)))

    const todos = store.getState().todos
    log('  todos = ' + JSON.stringify(todos.map((t) => ({ text: t.text, done: t.done }))))

    ok(applyCalls.length >= 2, `模型至少提交了两次任务计划（登记 + 勾选），实际 ${applyCalls.length}`)
    ok(todos.length === 3, `清单是 3 条（模型自己写的那三步），实际 ${todos.length}`)
    ok(
      todos.length === 0 || new Set(todos.map((t) => t.text.trim())).size === todos.length,
      '三条文字互不相同（不是复制同一条）'
    )
    const doneCount = todos.filter((t) => t.done).length
    ok(doneCount >= 1, `至少一条被标完成（实际 ${doneCount}/${todos.length}）`)

    for (const fold of qa('[data-testid="turn-process-toggle"][aria-expanded="false"]')) {
      click(fold)
      await sleep(250)
    }
    await sleep(400)

    const originRows = qa('.trow[data-origin="yan-task-plan"]')
    log('  标记为任务计划的工具行：' + originRows.length + ' 条')
    ok(originRows.length >= 1, '至少一条工具行被标为砚内置任务计划')
    ok(
      originRows.every((r) => r.dataset.tool === 'bash'),
      '标记的仍然是 bash 卡（不伪造原生独立工具事件）'
    )
    const originTargets = originRows
      .map((r) => r.querySelector('.trow-target')?.textContent ?? '')
      .join(' | ')
    log('  标记行的标题：' + JSON.stringify(originTargets.slice(0, 160)))
    const applyCmds = calls.filter((c) => /tasks apply/.test(String(c.args?.command ?? '')))
    log(`  含 \`yan tasks apply\` 的调用：${applyCmds.length} 条`)
    ok(
      /tasks apply/.test(originTargets) || applyCmds.length >= 1,
      '标记的正是 `yan tasks apply` 那条命令（标题被截断时用调用数据核对）'
    )

    const writes = calls.filter((c) => c.name === 'write')
    const writeTargets = writes.map((c) => String(c.args?.path ?? c.args?.file_path ?? '')).join(' | ')
    log('  write 调用：' + writes.length + ' 次 → ' + JSON.stringify(writeTargets.slice(0, 200)))
    ok(writes.length >= 1, '模型真的写了文件（用 write 工具，不是嘴上说完成）')

    log(`taskplan.sessionId=${sess()?.sessionId ?? ''}`)
    log(`taskplan.sessionFile=${sess()?.sessionFile ?? ''}`)
    log(`taskplan.todos=${JSON.stringify(todos.map((t) => ({ text: t.text, done: !!t.done })))}`)
    return out.join('\n')
  } catch (e) {
    return fail('探针异常：' + (e && e.stack ? e.stack : String(e)))
  }
})()
