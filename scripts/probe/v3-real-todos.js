;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const store = window.__yanStore

  const composer = window.__yanComposer
  const setValue = (el, text) => composer.set(text, el)
  const runningNow = (s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true
  const countOf = (s) => {
    const todos = s.todos ?? []
    return { total: todos.length, done: todos.filter((t) => t.done).length, label: `${todos.filter((t) => t.done).length}/${todos.length}` }
  }

  const seq = []
  const domLog = []
  let recording = false
  let pollTimer = null

  try {
    out.push('=== v3 Agent 实时计划卡（停靠在输入框上方，真实模型）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 10000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }
    check(await until(() => !!q('composer-input'), 8000), '正式输入框已挂载')
    check(await until(() => store.getState().conn === 'ready', 120000), `pi 已就绪（conn=${store.getState().conn}）`)

    store.subscribe((s) => {
      if (!recording) return
      const c = countOf(s)
      if (!seq.length || seq[seq.length - 1].label !== c.label) {
        seq.push({ t: Date.now(), label: c.label, total: c.total, done: c.done })
      }
    })

    const planSet = JSON.stringify({
      action: 'set',
      items: [
        { text: '读取现状', done: false },
        { text: '修改代码', done: false },
        { text: '运行验证', done: false }
      ]
    })
    const steps = [
      '请只做任务清单维护，不要做其它事、不要调用别的工具：',
      `1. 用 write 工具在当前工作目录创建 task-1.json，内容为 ${planSet}`,
      '2. 用 bash 运行 `yan tasks apply --request-file task-1.json`',
      '3. 用 write 创建 task-2.json，内容为 {"action":"complete","index":1}，再用 bash 运行 `yan tasks apply --request-file task-2.json`',
      '4. 对 index 2 与 index 3 各重复一次第 3 步（分别写 task-3.json / task-4.json，并各运行一次 yan tasks apply）',
      '5. 三项都完成后只回复「三项待办已完成」'
    ].join('\n')

    const statsBefore = store.getState().stats?.tokens?.total ?? 0
    seq.length = 0
    recording = true
    const ta = q('composer-input')
    setValue(ta, steps)
    const ready = await until(() => {
      const b = q('composer-send')
      return !!b && b.disabled !== true && b.getAttribute('aria-disabled') !== 'true'
    }, 6000)
    check(ready, '消息已提交（1 条）')
    q('composer-send')?.click()

    pollTimer = setInterval(() => {
      if (!recording) return
      domLog.push({ t: Date.now(), tile: !!q('plan-card'), running: runningNow(store.getState()) })
    }, 100)

    check(await until(() => runningNow(store.getState()), 45000), '回合进入运行中')
    const tileWhileRunning = await until(() => !!q('plan-card') && runningNow(store.getState()), 240000)
    check(tileWhileRunning, '运行中输入框上方实时出现计划卡（plan-card）')

    const finished = await until(() => !runningNow(store.getState()), 300000)
    recording = false
    if (pollTimer) clearInterval(pollTimer)
    check(finished, '回合自然结束')

    out.push('')
    out.push('--- 计数序列 ---')
    note(`store.todos 计数序列：${seq.map((s) => s.label).join(' → ') || '(无变化)'}`)
    const domTile = domLog.some((x) => x.tile && x.running)
    check(domTile || tileWhileRunning, '至少有一次「运行中且磁贴可见」的采样')

    await until(() => countOf(store.getState()).label === '3/3', 15000)
    const final = countOf(store.getState())
    check(final.total === 3, `清单共 3 项（实际 ${final.total}）`)
    check(final.done === 3, `结束全部完成（${final.label}）`)

    const labels = seq.map((s) => s.label)
    const distinct = [...new Set(labels)]
    check(distinct.length >= 2, `计数 x/y 递增（观察到 ${distinct.length} 个不同值：${distinct.join(' / ')}）`)
    const monotonic = seq.every((s, i) => i === 0 || s.done >= seq[i - 1].done)
    check(monotonic, '完成数单调不减（没有回退）')

    check(await until(() => !q('plan-card'), 10000), '全部完成后计划卡整块隐藏（不残留已完成清单）')

    const statsAfter = store.getState().stats?.tokens?.total ?? 0
    note(`会话统计 token：${statsBefore} → ${statsAfter}`)
    const cost = store.getState().stats?.cost
    if (typeof cost === 'number') note(`会话累计费用（pi 口径）≈ $${cost.toFixed(6)}`)
    out.push('证据范围：真实模型驱动的任务工具写入 → 宿主推送 → 输入框上方的计划卡；模型固定 commandcode/deepseek/deepseek-v4.1-flash。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  } finally {
    if (pollTimer) clearInterval(pollTimer)
  }
  return out.join('\n')
})()
