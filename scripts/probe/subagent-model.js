/*
 * 模型可调用子代理的真实端到端场景：
 *   父模型 → bash → yan subagent start → 主进程 SubagentController → UI 实时列表/详情。
 *
 * 这条场景与 subagent.js 的区别是：启动动作不能由 store/UI 直接发起，
 * 必须由父模型自己执行 `yan`，用来验证 capability-guide + PATH/身份接线。
 * 花 token，不进入默认的零成本 live 门槛。
 */
;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => [...document.querySelectorAll(selector)]
  const store = window.__yanStore

  const prompt = [
    '请验证砚的子代理能力。必须使用 bash 执行一次：',
    'yan subagent start --task "请只回答两个字：收到"',
    '不要直接替我完成这个任务，也不要编造结果。拿到子代理 ID 后，',
    '再用 yan subagent get --id <ID> 查看一次状态，最后简要报告两个命令的摘要。'
  ].join(' ')

  try {
    for (let i = 0; i < 60; i++) {
      if (store?.getState().settings && q('[data-testid="composer"]')) break
      await sleep(250)
    }
    const ta = q('[data-testid="composer"]')
    if (!ta) return '✗ 找不到输入框'

    out.push('=== 父模型通过 yan CLI 调用子代理 ===')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, prompt)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const send = q('[data-testid="send"]')
    if (!send || send.disabled) return '✗ 发送键不可用'
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const before = store.getState().subagents.length
    let started = null
    const startDeadline = Date.now() + 120_000
    while (Date.now() < startDeadline) {
      const runs = store.getState().subagents
      if (runs.length > before) {
        started = runs[runs.length - 1]
        break
      }
      await sleep(500)
    }

    ok(!!started, '父模型通过 yan subagent start 创建了真实 run')
    if (!started) {
      const text = document.body.innerText || ''
      ok(!/不是内部或外部命令|command not found|is not recognized|宿主能力服务不可用|YAN_CLI_URL/i.test(text), '没有出现 yan 不可用错误')
      return out.join('\n')
    }

    ok(/^sub-[0-9a-f]+$/.test(started.id), `返回合法子代理 ID（${started.id}）`)
    ok(started.parentRunId || started.parentSessionId, 'run 记录了父会话关系')
    ok(!!q(`[data-testid="subagent-${started.id}"]`), '模型启动的 run 出现在输入区上方列表')
    ok(!!q('[data-testid="subagent-preview"]'), '模型启动后详情面板自动打开（不需要用户再点一下）')

    let final = started
    const doneDeadline = Date.now() + 120_000
    while (Date.now() < doneDeadline) {
      final = store.getState().subagents.find((run) => run.id === started.id) || final
      if (['done', 'error', 'cancelled'].includes(final.status)) break
      await sleep(500)
    }
    out.push(`  子代理终态 = ${final.status}，转录 ${final.transcript?.length ?? 0} 条`)
    ok(['done', 'error', 'cancelled'].includes(final.status), '子代理最终离开运行态')

    const text = document.body.innerText || ''
    ok(!/不是内部或外部命令|command not found|is not recognized|宿主能力服务不可用|YAN_CLI_URL/i.test(text), '模型调用链没有出现 yan 不可用错误')
    ok(qa('[data-testid^="subagent-"]').length > 0, '页面仍保留用户可查看的子代理元素')

    await window.yan.subagents.clearFinished()
    await sleep(300)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()

