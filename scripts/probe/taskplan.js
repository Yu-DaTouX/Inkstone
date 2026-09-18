/*
 * 真实多步任务 + 任务计划（实施-02 S5）。
 *
 * 与 `taskcli`（S3）的区别 —— 两者的**证据类型不同**，缺一不可：
 *   · `taskcli`：request 文件由 Node 侧预置，验的是**宿主写入链**
 *     （模型照用法敲一条命令 → 界面清单 → 切会话读回）。它不验「模型能不能自己
 *     写这份 JSON」，因为那会引入模型侧的随机性，把写入链的信号淹掉。
 *   · 本场景：整条链**全由模型驱动** —— 它自己决定要几步、自己写请求文件、
 *     自己执行、自己在做完之后勾选。这正是 S5 的验收条件
 *     「真实模型（cost 1）：一个确实需要多步执行的可控任务，不能仅造 fixture」。
 *
 * 可观测的产物分三层（三处一致就是在**这一条**里核）：
 *   ① 工具调用：界面上的 `yan tasks apply` 工具行（且标为砚内置来源）；
 *   ② 原生任务清单：探针报告的 `taskplan.todos`（渲染端看到的）；
 *   ③ 实际落盘：`YAN_DATA_DIR/task-plans/<sessionId>.jsonl`
 *      —— 由 `afterExit: taskPlanMultiStep` 在 Electron 退出后逐行核对，
 *      并与 ② 逐条比对；同时确认会话 JSONL 里**没有**任务条目。
 *
 * 任务本身是真实动作（在 fixture 项目里建三个文件），所以退出后还能核对
 * 「模型是不是光在嘴上说完成」——`tasks/step-*.txt` 真的存在才算做完。
 *
 * 花 token（cost: 1），不在默认门槛里跑。
 */
;(async () => {
  /*
   * 提示词的两条要求都是为了**去随机性**，不是为了替模型做题：
   *   · 任务给死（建三个文件、每步一行说明）→ 判据可枚举；
   *   · 请求形状给死（action / items / index 从 0 开始）→ 验的是链路，
   *     不是模型的 JSON 直觉。内容仍由模型自己写（清单文字、文件正文）。
   */
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

  /* 与 taskcli 同一套判据：回合级 `isAgentRunning`，不用工具行的 running（两次调用之间会闪） */
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

    /* 清单可能比回合结束稍晚（refreshTodos 是异步推送），给足等待 */
    await until(() => store.getState().todos.length > 0, 20000)

    /*
     * 工具组默认收起、且**收起时内部的行不在 DOM 里**（`tgroup-body` 不渲染）。
     * 不展开就数 `.trow`，测到的是「组是收起的」而不是「有没有这条调用」——
     * 这个坑在 taskcli 里已经让一次真实失败（yan.mjs 语法错）被误读成「模型没调工具」。
     */
    qa('.tgroup-head').forEach((h) => click(h))
    await sleep(600)

    /*
     * 失败诊断：这三段能把「模型没按格式做」「yan 报错」「界面没刷新」区分开，
     * 而只报一条 ✗ 分不清（免费模型不照做是常见结局，没有诊断就得白查一轮）。
     */
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

    /*
     * 硬断言 1：模型真的用了任务计划（不是自己闷头建完文件就完事）。
     * 这条是本场景存在的理由 —— 若它红，说明「要求模型使用任务计划」这件事
     * 在当前提示与模型下不成立，需要改的是**指导语**（§7 的限制里说清楚了）。
     */
    ok(applyCalls.length >= 2, `模型至少提交了两次任务计划（登记 + 勾选），实际 ${applyCalls.length}`)
    ok(todos.length === 3, `清单是 3 条（模型自己写的那三步），实际 ${todos.length}`)
    ok(
      todos.length === 0 || new Set(todos.map((t) => t.text.trim())).size === todos.length,
      '三条文字互不相同（不是复制同一条）'
    )
    /* 至少有一条被勾上：证明 complete 真的走通了（全勾上更好，但不强求 —— 见 §7） */
    const doneCount = todos.filter((t) => t.done).length
    ok(doneCount >= 1, `至少一条被标完成（实际 ${doneCount}/${todos.length}）`)

    /*
     * 硬断言 2：这些调用在界面上标了**砚内置任务计划**来源。
     * 走的是 S4 那条文本判定（`shared/tool-origin.ts`）——
     * 这里顺带证明它在真实模型写出命令时也能命中（不是只有合成输入命中）。
     */
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
    ok(/tasks apply/.test(originTargets), '标记的正是 `yan tasks apply` 那条命令')

    /*
     * 硬断言 3：真实文件动作确实发生了（模型不是只登记计划）。
     * 渲染端看不到磁盘，只能看**工具调用**里有没有 write；真实文件由
     * `afterExit: taskPlanMultiStep` 在退出后核对。
     */
    const writes = calls.filter((c) => c.name === 'write')
    const writeTargets = writes.map((c) => String(c.args?.path ?? c.args?.file_path ?? '')).join(' | ')
    log('  write 调用：' + writes.length + ' 次 → ' + JSON.stringify(writeTargets.slice(0, 200)))
    ok(writes.length >= 1, '模型真的写了文件（用 write 工具，不是嘴上说完成）')

    /* 退出后检查的取证行：afterExit 靠这几行定位日志并与界面逐条比对 */
    log(`taskplan.sessionId=${sess()?.sessionId ?? ''}`)
    log(`taskplan.sessionFile=${sess()?.sessionFile ?? ''}`)
    log(`taskplan.todos=${JSON.stringify(todos.map((t) => ({ text: t.text, done: !!t.done })))}`)
    return out.join('\n')
  } catch (e) {
    return fail('探针异常：' + (e && e.stack ? e.stack : String(e)))
  }
})()
