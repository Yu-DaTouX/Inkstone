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
    const sessionId = 'feedback-session'
    const notice = '<subagent-notification id="sub-feedback" status="error">\n后台专用结果不应展示\n</subagent-notification>'
    const task = '实现独立 Hermes OneBot QQ 平台插件，仅修改指定目录。' + '这是完整任务边界与交付要求。'.repeat(45)
    const run = {
      id: 'sub-feedback', task, cwd: '', parentSessionId: sessionId, parentMessageId: 'a1',
      isolation: 'worktree', model: 'commandcode/deepseek/deepseek-v4.1-flash',
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
      progressWarning: '超过 5 分钟未收到进展，可能仍在执行工具或等待模型；任务继续运行', latestActivity: '运行 bash' }] })
    ok(await wait(() => q('[data-testid="subagent-note-activity-sub-feedback"]')?.textContent.includes('任务继续运行')), '无进展提醒可见且仍可停止')
    ok(!!q('[data-testid="subagent-note-stop-sub-feedback"]'), '运行中的任务保留停止入口')
    store.setState({ subagents: [{ ...run, status: 'running', endedAt: undefined, endReason: undefined, error: undefined, latestActivity: '工具已返回，继续处理' }] })
    ok(await wait(() => q('[data-testid="subagent-note-activity-sub-feedback"]')?.textContent.includes('工具已返回')), '进展恢复后提醒消失')
    // 留下紧凑错误状态截图；窗口由测试驱动统一保存。
    store.setState({ subagents: [run] })
    await sleep(2400)
  } catch (error) { out.push(`✗ ${error.stack || error}`) }
  return out.join('\n')
})()
