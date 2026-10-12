/** 隔离桌面的紧凑任务卡、后台通知与错误呈现；全部是合成数据。 */
;(async () => {
  const out = []
  const ok = (value, label) => out.push(`${value ? '✓' : '✗'} ${label}`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async fn => { for (let n = 0; n < 80; n++) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const q = selector => document.querySelector(selector)
  try {
    ok(await wait(() => store?.getState().settings), '桌面已就绪')
    ok(await wait(() => store.getState().subagents.some(run => run.id === 'sub-history')), '不打开子代理窗口，启动时已恢复历史列表')
    const sessionId = 'feedback-session'
    const notice = '<subagent-notification id="sub-feedback" status="error">\n后台专用结果不应展示\n</subagent-notification>'
    const task = '实现独立 Hermes OneBot QQ 平台插件，仅修改指定目录。' + '这是完整任务边界与交付要求。'.repeat(45)
    const run = {
      id: 'sub-feedback', task, cwd: '', parentSessionId: sessionId, parentMessageId: 'a1',
      isolation: 'controlled-cwd', model: 'openai-codex/gpt-6-luna', thinkingLevel: 'low',
      contextUsage: { tokens: 84_000, contextWindow: 272_000, percent: 84_000 / 272_000 * 100 },
      status: 'error', endReason: 'timeout', startedAt: Date.now() - 900000, endedAt: Date.now(),
      error: '运行超时（超过 15 分钟）', review: 'none', toolCalls: 6,
      result: { summary: '这一段是只在详情查看的完整产出。', summaryFrom: 'last-message' },
      transcript: [{ id: 'child-1', role: 'assistant', text: '这一段是只在详情查看的完整产出。', toolCalls: [{ id: 'call-1', name: 'bash', args: { command: 'bounded search' }, status: 'error' }] }]
    }
    const messages = [
      { id: 'u1', role: 'user', text: '请实现插件，并说明失败原因。' },
      { id: 'a1', role: 'assistant', text: '正在等待子任务结果。' },
      { id: 'host1', role: 'user', text: notice },
      { id: 'a2', role: 'assistant', text: '', error: '模型连接或响应流意外中断。现有信息无法确认中断源，可检查网络后重试。原因：terminated' }
    ]
    store.setState({ settings: { ...store.getState().settings, workspaceMode: 'coding', onboardingDone: true },
      session: { ...store.getState().session, sessionId, conversationId: sessionId },
      messages, subagents: [run], streamingId: null, isStreaming: false, workspaceMode: 'coding', peekedPath: null, peekedSessionId: null })
    ok(await wait(() => q('[data-testid="subagent-note-sub-feedback"]')), '任务卡实际渲染')
    let card = q('[data-testid="subagent-note-sub-feedback"]')
    ok(!q('[data-testid="subagent-detail-sub-feedback"]'), '默认不展开工具与全文')
    const metadata = [...card.querySelectorAll('.sg-meta > .sg-meta-item')].map(item => item.textContent)
    ok(metadata.length === 5 && metadata[0] === '只读' && metadata[1] === 'gpt-6-luna' && metadata[2] === '思考 low' && metadata[3].includes('上下文 84k / 272k (31%)') && metadata[4].includes('15'), '第二行按范围、模型、思考、上下文、时间顺序显示')
    ok(!q('[data-testid="subagent-note-tag-sub-feedback"]'), '第二行不再重复子代理标签')
    store.setState({ subagents: [{ ...run, model: undefined, thinkingLevel: undefined, contextUsage: undefined }] })
    ok(await wait(() => q('[data-testid="subagent-note-context-sub-feedback"]')?.textContent === '上下文 —'), '历史记录缺少原生上下文时显示未知')
    ok(q('[data-testid="subagent-note-thinking-sub-feedback"]')?.textContent === '思考 —', '缺失思考档位时不猜测')
    ok(q('[data-testid="subagent-note-model-sub-feedback"]')?.textContent === '—', '缺失模型显示未知，不冒充默认模型')
    store.setState({ subagents: [run] })
    await sleep(100)
    ok(!card.textContent.includes('完整产出'), '默认不展示产出正文')
    ok(card.getBoundingClientRect().height < 125, `卡片保持紧凑（${Math.round(card.getBoundingClientRect().height)}px）`)
    ok(!document.body.textContent.includes('后台专用结果不应展示'), '宿主通知没有用户气泡或后台文本泄露')
    ok(q('.msg-error')?.textContent.includes('terminated'), '模型错误显示实际原因')
    const rect = card.getBoundingClientRect()
    ok(rect.left >= 0 && rect.right <= innerWidth, '任务卡不超出窗口')
    const details = card.querySelector('button[aria-expanded]')
    details.click()
    ok(await wait(() => q('[data-testid="subagent-detail-sub-feedback"]')), '键盘可访问的详情按钮可展开')
    ok(card.textContent.includes(task) && card.textContent.includes('bounded search'), '完整任务与最近调用按需查看')
    details.click()
    ok(await wait(() => !q('[data-testid="subagent-detail-sub-feedback"]')), '详情可再次收起')
    store.setState({ subagents: [{ ...run, status: 'running', endedAt: undefined, endReason: undefined, error: undefined,
      wrapUp: { reason: 'timeout', since: Date.now() }, progressWarning: '停滞超时（超过 10 分钟未收到模型输出或工具事件）', latestActivity: '停滞超时，正在收尾…' }] })
    ok(await wait(() => q('[data-testid="subagent-note-activity-sub-feedback"]')?.textContent.includes('停滞超时')), '停滞超时原因可见且仍可停止')
    ok(!!q('[data-testid="subagent-note-stop-sub-feedback"]'), '运行中的任务保留停止入口')
    store.setState({ subagents: [{ ...run, status: 'running', endedAt: undefined, endReason: undefined, error: undefined, latestActivity: '工具已返回，继续处理' }] })
    ok(await wait(() => q('[data-testid="subagent-note-activity-sub-feedback"]')?.textContent.includes('工具已返回')), '普通运行显示真实进展')
    // 同一回合并行的一组：已完成且无需处理的收进汇总行，运行中与出错的始终显示。
    const done = (id, i) => ({ ...run, id, task: `并行审查分区 ${i}`, status: 'done', endReason: 'completed', error: undefined, startedAt: run.startedAt + i })
    const group = [{ ...run, status: 'running', endedAt: undefined, endReason: undefined, error: undefined, latestActivity: '正在读取文件' }, done('sub-g1', 1), done('sub-g2', 2), { ...run, id: 'sub-g3', task: '并行审查分区 3', startedAt: run.startedAt + 3 }]
    store.setState({ subagents: group })
    ok(await wait(() => q('[data-testid="subagent-group-head"]')?.textContent.includes('并行 4 个')), '并行组显示汇总行')
    const head = q('[data-testid="subagent-group-head"]')?.textContent ?? ''
    ok(head.includes('运行中 1') && head.includes('需处理 1') && head.includes('已完成 2'), `汇总行分别计数（${head}）`)
    ok(!q('[data-testid="subagent-note-sub-g1"]') && !!q('[data-testid="subagent-note-sub-g3"]') && !!q('[data-testid="subagent-note-sub-feedback"]'), '已完成的默认收起，运行中与出错的仍显示')
    await sleep(1500)
    q('[data-testid="subagent-group-toggle"]')?.click()
    ok(await wait(() => q('[data-testid="subagent-note-sub-g1"]') && q('[data-testid="subagent-note-sub-g2"]')), '展开后显示已完成的卡片')
    ok(!q('[data-testid="subagent-note-sub-g1"] .sg-meta'), '已完成卡片只保留第一行')
    await sleep(1500)
    q('[data-testid="subagent-group-toggle"]')?.click()
    ok(await wait(() => !q('[data-testid="subagent-note-sub-g1"]')), '可以再次收起')
    store.setState({ subagents: [done('sub-g1', 1)] })
    ok(await wait(() => q('[data-testid="subagent-note-sub-g1"]') && !q('[data-testid="subagent-group-head"]')), '单个子代理不显示汇总行也不折叠')
    // 通过真实 IPC 读冷启动磁盘历史，而非只往渲染端塞一条假记录。
    await store.getState().loadSubagents()
    const restored = store.getState().subagents.find(item => item.id === 'sub-history')
    ok(restored?.transcript[0]?.toolCalls?.[0]?.output === '历史工具结果', '冷启动真实 IPC 恢复磁盘调用结果')
    ok(restored?.parentSessionId === sessionId && restored.status === 'done', '恢复历史仍归原会话，不恢复执行')
    store.setState({ subagents: [run, restored].filter(Boolean) })
    window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: 'subagent:sub-history' }))
    ok(await wait(() => q('.agent-message-stream')?.textContent.includes('重启后保存的最终回复')), '子代理过程窗口显示恢复的最终回复')
    const stream = q('.agent-message-stream')
    const caption = stream?.parentElement?.querySelector('.agent-message-caption')
    const promptEl = stream?.querySelector('[data-testid="subagent-prompt-sub-history"]')
    ok(/历史任务：只读检查/.test(promptEl?.textContent ?? ''), '过程窗口顶部显示发给子代理的任务原文')
    ok((stream.textContent.match(/历史任务：只读检查/g) ?? []).length === 1, '任务原文只出现一次，不重复转录里的用户消息')
    promptEl?.querySelector('summary')?.click()
    await sleep(200)
    ok(promptEl?.open === false, '任务原文可以收起')
    promptEl?.querySelector('summary')?.click()
    await sleep(200)
    ok(promptEl?.open === true, '任务原文可以再次展开')
    stream?.querySelector('[data-testid="turn-process-toggle"]')?.click()
    await wait(() => stream?.querySelector('[data-testid="tool-group-toggle"]'))
    stream?.querySelector('[data-testid="tool-group-toggle"]')?.click()
    ok(await wait(() => stream?.querySelector('[data-testid="tool-row"]')?.textContent.includes('example.ts')), '恢复的历史调用可以展开查看目标')
    stream?.querySelector('[data-testid="tool-row"]')?.click()
    ok(await wait(() => stream?.textContent.includes('历史工具结果')), '恢复的历史工具结果可再次展开查看')
    // 保留历史过程窗口截图；主会话另核对紧凑卡片的已有截图。
    await sleep(2400)
  } catch (error) { out.push(`✗ ${error.stack || error}`) }
  return out.join('\n')
})()
