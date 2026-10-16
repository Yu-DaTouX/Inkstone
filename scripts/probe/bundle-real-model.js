/** Small paid-model acceptance: current host, native RPC, tools, streaming and explicit read-only child. */
;(async () => {
  const MODEL = 'commandcode/deepseek/deepseek-v4.1-flash'
  const MODEL_ID = 'deepseek/deepseek-v4.1-flash'
  const CHILD_TASK = 'YAN-BUNDLE-CHILD：只回复 YAN-BUNDLE-CHILD-OK，不调用工具，不委派，不改文件。'
  const out = []
  let checks = 0
  let childId
  const store = window.__yanStore
  const s = () => store.getState()
  const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async (condition, timeout = 20000) => {
    const end = Date.now() + timeout
    do { if (condition()) return true; await pause(100) } while (Date.now() < end)
    return false
  }
  const check = (value, label) => {
    checks++
    out.push(`${value ? '  ✓' : '  ✗'} ${label}`)
    if (!value) throw new Error(label)
  }
  const q = selector => document.querySelector(selector)
  const animations = new Map()
  const onAnimation = event => {
    if (event.animationName === 'mo-item-in' && event.target.matches('.md-arrive')) {
      animations.set(event.target, (animations.get(event.target) ?? 0) + 1)
    }
  }
  document.addEventListener('animationstart', onAnimation, true)
  try {
    check(await wait(() => s().conn === 'ready'), '隔离宿主原生 pi 已就绪')
    const models = await window.yan.listModels()
    const match = models.find(model => model.provider === 'commandcode' && model.id === MODEL_ID)
    check(!!match, '指定 DeepSeek Flash 在真实模型目录中，不换模型')
    check(typeof match.api === 'string' && !!match.api, '原生模型 API 身份经正式归一化与IPC保留')
    out.push('  模型=' + JSON.stringify({ provider: match.provider, id: match.id, api: match.api, contextWindow: match.contextWindow }))
    const quota = await window.yan.providerQuota('commandcode')
    check(!quota.error && !quota.staleError && quota.windows?.length > 0, '调用前取得当前真实额度，不使用陈旧缓存')
    out.push('  额度窗口=' + JSON.stringify(quota.windows.map(({id, used, total, exceeded, estimated}) => ({id, used, total, exceeded, estimated}))))
    check(quota.windows.filter(w => !w.informational).every(w => !w.exceeded && w.used < w.total), '受限额度窗口仍可用')
    const selected = await window.yan.setModel('commandcode', MODEL_ID)
    check(selected.ok, '原生 set_model 选择指定模型成功')
    const textarea = q('[data-testid="composer"]')
    check(!!textarea, '当前真实 Composer 可用')
    const command = `yan subagent start --task "${CHILD_TASK}" --model "${MODEL}" --read-only`
    const prompt = `这是隔离验收任务，请严格执行两条安全命令：先用 bash 执行 echo YAN-BUNDLE-MAIN-OK，再用 bash 执行 ${command}。第二条只启动只读验收子进程，不用等待或查询它，绝对不要再启动其他子代理。不要读文件或改文件。最后用中文写三个段落，每段150字左右，段落之间空一行，介绍流式回复、只读边界和真实工具结果；第一段包含 YAN-BUNDLE-MAIN-OK。不要额外调用工具。`
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, prompt)
    textarea.dispatchEvent(new Event('input', {bubbles: true}))
    await pause(150)
    const send = q('[data-testid="send"]')
    check(send && !send.disabled, '输入后真实发送按钮可用')
    send.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
    let sawRunning = false
    let bodyChanges = 0
    let prior = ''
    let sawArrival = false
    let nestedArrival = false
    const deadline = Date.now() + 180000
    let settledSince = 0
    while (Date.now() < deadline) {
      sawRunning ||= !!s().session?.isAgentRunning
      const body = [...document.querySelectorAll('.msg.assistant .md')].map(el => el.textContent).join('\n')
      if (body !== prior && body.length) { bodyChanges++; prior = body }
      sawArrival ||= !!q('.md-arrive')
      nestedArrival ||= !!q('.md-arrive .md-arrive')
      const child = s().subagents.find(run => run.task === CHILD_TASK)
      if (child) childId = child.id
      if (sawRunning && !s().session?.isAgentRunning && body.includes('YAN-BUNDLE-MAIN-OK') && child && ['done', 'error', 'cancelled'].includes(child.status)) {
        // A child completion notification can immediately start another real response.
        settledSince ||= Date.now()
        if (Date.now() - settledSince >= 2000) break
      } else settledSince = 0
      await pause(80)
    }
    await pause(500)
    const child = s().subagents.find(run => run.id === childId)
    out.push('  子进程诊断=' + JSON.stringify(child && {id: child.id, status: child.status, error: child.error, model: child.model, isolation: child.isolation, contextUsage: child.contextUsage, usage: child.usage, tools: child.transcript?.filter(m => m.role === 'tool').map(m => m.toolName)}))
    check(sawRunning, '观察到真实主回合运行状态')
    check(!s().session?.isAgentRunning, '主回合真实结束，没有卡在运行状态')
    check(bodyChanges > 1, `正文实际增量更新（${bodyChanges}次，不打桩）`)
    const tools = s().messages.flatMap(m => m.toolCalls ?? [])
    check(tools.some(tool => tool.name === 'bash' && JSON.stringify(tool.args ?? tool.arguments ?? '').includes('echo YAN-BUNDLE-MAIN-OK')), '持久消息有实际 bash echo 工具调用')
    check(prior.includes('YAN-BUNDLE-MAIN-OK'), '真实助手回复包含工具结果标记')
    check(!!child, '经模型工具调用正式 yan CLI 启动子进程')
    check(child.isolation === 'controlled-cwd', '显式 read-only 落到正式受控只读路径')
    check(child.model === MODEL, '子模型选择没有回退或换服务')
    check(child.status === 'done', `只读子模型真实完成（${child.status}；${child.error ?? '无错误'}）`)
    check(child.transcript.some(m => m.role === 'assistant' && m.text.includes('YAN-BUNDLE-CHILD-OK')), '子模型转录有真实回复标记')
    check(child.contextUsage?.contextWindow > 0, '子模型结束后读取原生上下文窗口')
    out.push('  子进程=' + JSON.stringify({id: child.id, model: child.model, isolation: child.isolation, contextUsage: child.contextUsage, usage: child.usage}))
    /*
     * 两层身份分开验：
     *   ① 持久化数据里保留 **provider + 原始 id**（不是显示名，也不能被截断）；
     *   ② 页脚展示的是**模型菜单里的显示名**（用户看到的那一项），不是恰好含 raw id。
     * title/aria-label 里同时给出身份，便于悬停核对。
     */
    const persistedModel = [...s().messages].reverse().find(m => m.role === 'assistant' && m.model)?.model
    check(persistedModel === MODEL, `持久化的回合模型保留 provider + 原始 id（${persistedModel ?? '缺'}）`)
    const displayName = match.name || MODEL_ID
    const turnModel = [...document.querySelectorAll('[data-testid="turn-model"]')].find(el => el.title?.includes(MODEL))
    check(!!turnModel, '回合页脚展示当前回合模型（title 含 provider/raw id 身份）')
    check(
      (turnModel?.textContent ?? '').trim() === displayName,
      `回合页脚显示模型菜单名（${displayName}）而不是裸 id`
    )
    const stats = await window.yan.getStats()
    check(stats?.contextUsage?.contextWindow > 0, '主回合结束有原生上下文窗口')
    out.push('  主原生上下文=' + JSON.stringify(stats.contextUsage))
    check(!nestedArrival, '真实流式期间没有嵌套块重复位移')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) out.push('  ~ 系统减少动效：动画入场断言不适用，不计作通过')
    else {
      check(sawArrival, '真实流式新块出现入场类')
      check(animations.size > 0, '实际 DOM 触发新块入场动画')
      out.push('  动画计数=' + JSON.stringify([...animations].map(([element, count]) => ({tag: element.tagName, count}))))
      check([...animations.values()].every(count => count === 1), '同一 DOM 块跨 token 没有重播动画')
    }
    check(!q('.md-arrive'), '回合结束后历史正文不保留入场类')
    out.push(`  完成 ${checks} 项检查；只断言本场景，不代表全部视觉或用户 MCP 验收。`)
  } catch (error) {
    out.push('  ✗ ' + String(error?.message ?? error))
    out.push('  状态=' + JSON.stringify({conn: s().conn, running: s().session?.isAgentRunning, childId, notices: s().notices?.map(n => n.text ?? n.message)}))
  } finally {
    document.removeEventListener('animationstart', onAnimation, true)
    if (s().session?.isAgentRunning) await window.yan.abort().catch(() => {})
    if (childId) {
      const child = s().subagents.find(run => run.id === childId)
      if (child && ['starting', 'running'].includes(child.status)) await window.yan.subagents.stop(childId)
    }
  }
  return out.join('\n')
})()
