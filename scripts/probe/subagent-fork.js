;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore

  const send = async (text) => {
    const ta = q('[data-testid="composer-input"]')
    if (!ta) throw new Error('找不到输入框')
    window.__yanComposer.set(text, ta)
    await sleep(200)
    const button = q('[data-testid="composer-send"]')
    if (!button || button.disabled) throw new Error('发送键不可用')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(3000)
  }
  const settle = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let idleSince = 0
    while (Date.now() < deadline) {
      const state = store.getState()
      const live = (state.subagents ?? []).some((run) => run.status === 'starting' || run.status === 'running')
      const busy = state.session?.isAgentRunning || state.session?.isStreaming || live
      if (busy) idleSince = 0
      else if (!idleSince) idleSince = Date.now()
      else if (Date.now() - idleSince > 15_000) return true
      await sleep(1000)
    }
    return false
  }
  const lastAnswer = () => {
    const answers = [...document.querySelectorAll('.v3-msg.assistant .v3-prose')].map((e) => e.textContent.trim()).filter(Boolean)
    return answers[answers.length - 1] ?? ''
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (store?.getState().settings && q('[data-testid="composer-input"]')) break
      await sleep(250)
    }
    out.push('=== fork 子代理（真实模型）===')
    await send('读一下 dup/one/same.ts 和 dup/two/same.ts 这两个文件，记住里面导出的常量名。这一步不要派子代理，读完用一句话回答即可。')
    ok(await settle(180_000), '第一轮读文件结束')

    await send([
      '现在派一个 fork 子代理完成这件事：在 dup/one/ 下新建 fork-note.txt，内容是两个文件导出的常量名，用英文逗号分隔。',
      '它继承了我们的对话，所以让它直接用对话里已经读到的内容，不要重新读这两个文件。',
      '必须用 yan subagent start --fork --title fork验证 --task "<任务>" 派出（不要加 --model 或 --read-only），',
      '派出后不要轮询，等宿主通知它结束，再用一句话告诉我它的结论。'
    ].join(''))
    ok(await settle(360_000), '派 fork 并等它结束')

    const runs = store.getState().subagents ?? []
    const forkRun = runs.find((run) => run.fork)
    out.push(`  子代理：${JSON.stringify(runs.map((run) => ({ id: run.id, fork: !!run.fork, status: run.status, model: run.model, error: run.error })))}`)
    ok(!!forkRun, '派出的子代理带 fork 标记')
    ok(forkRun?.status === 'done', `fork 子代理正常结束（${forkRun?.status} ${forkRun?.error ?? ''}）`)
    ok(forkRun?.model === 'commandcode/deepseek/deepseek-v4.1-flash', `fork 子代理沿用父会话模型（${forkRun?.model}）`)
    const transcript = forkRun?.transcript ?? []
    const firstUser = transcript.find((msg) => msg.role === 'user')
    ok(!!firstUser && /fork-directive/.test(firstUser.text ?? ''), 'fork 转录从指令开始，不重复显示继承的历史')
    const reads = transcript.flatMap((msg) => msg.toolCalls ?? []).filter((tool) => tool.name === 'read' && /same\.ts/.test(JSON.stringify(tool.args ?? {})))
    out.push(`  fork 重新读 same.ts 次数：${reads.length}`)
    out.push(`  fork 用量：${JSON.stringify(forkRun?.usage ?? null)}`)
    out.push(`  FORK_ID=${forkRun?.id ?? ''}`)
    const final = lastAnswer()
    out.push('  模型最终回答: ' + JSON.stringify(final.slice(0, 300)))
    ok(/one/.test(final) && /two/.test(final) && !/等宿主通知|不轮询/.test(final), '父会话收到完成通知后给出了总结（不是停在「已派出」）')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
