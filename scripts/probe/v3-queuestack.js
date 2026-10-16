;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
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
  const qa = (testId) => [...document.querySelectorAll(`[data-testid="${testId}"]`)]
  const store = window.__yanStore

  const S = '插话：先解释一下'
  const F1 = '排队一：再补一个例子'
  const F2 = '排队二：最后总结'

  try {
    out.push('=== v3 排队消息（隔离探针）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000),
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

    const calls = []
    const retractCalls = []
    store.setState({
      queue: {
        steering: [{ id: 's1', text: S }],
        followUp: [{ id: 'f1', text: F1 }, { id: 'f2', text: F2 }]
      },
      steerQueued: async (queueId) => { calls.push(queueId) },
      removeQueued: async (queueId) => { retractCalls.push(queueId) }
    })

    out.push('')
    out.push('--- 1. 位置 ---')
    check(await until(() => !!q('queue-stack')), '出现排队消息区（queue-stack）')
    const stack = q('queue-stack')
    const composer = document.querySelector('.composer')
    check(!!composer, '输入框 .composer 存在')
    if (stack && composer) {
      const sb = stack.getBoundingClientRect()
      const cb = composer.getBoundingClientRect()
      check(sb.bottom <= cb.top + 2, `队列在输入框上方（stack.bottom=${Math.round(sb.bottom)} composer.top=${Math.round(cb.top)}）`)
    }

    out.push('')
    out.push('--- 2. 内容与按钮 ---')
    const rows = qa('queue-row')
    check(rows.length === 3, `三条排队（实际 ${rows.length}）`)
    const text = stack?.textContent ?? ''
    check(text.includes(S) && text.includes(F1) && text.includes(F2), '三条文本都显示出来')
    const jumps = qa('queue-steer')
    check(jumps.length === 2, `只有 follow-up 行有插队按钮（实际 ${jumps.length}）`)
    check(text.includes('插话中'), 'steering 行显示「插话中」')

    out.push('')
    out.push('--- 3. 插队接线 ---')
    jumps[0]?.click()
    check(await until(() => calls.length === 1), '点击插队调用了 steerQueued')
    check(calls[0] === 'f1', `携带稳定 queueId=f1（实际 ${JSON.stringify(calls)}）`)

    out.push('')
    out.push('--- 4. 撤回接线 ---')
    const retracts = qa('queue-retract')
    check(retracts.length === 3, `两类消息都有撤回按钮（实际 ${retracts.length}）`)
    retracts[0]?.click()
    check(await until(() => retractCalls.length === 1), '点击撤回调用了 removeQueued')
    check(retractCalls[0] === 's1', `携带稳定 queueId=s1（实际 ${JSON.stringify(retractCalls)}）`)

    store.setState({ queue: { steering: [], followUp: [] } })
    await until(() => !q('queue-stack'), 2000)
    check(true, '探针结束（队列已清空）')
    out.push('证据范围：隔离注入的队列 DOM 与 spy 接线；不代表真实队列投递 / 模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
