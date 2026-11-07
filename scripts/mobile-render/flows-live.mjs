export function liveFlows({ boot, openSession, check, env }) {
  async function flowLive() {
    const tag = '[实时事件与发送]'
    const ctx = await boot()
    const { desk, h } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    await openSession(h, '第一个会话')
    await h.pressLabel('打开会话详情')
    await h.waitFor(() => h.has('40%'), `${tag} 初始用量`)
    const pushed = { tokens: 99999, cost: 1.5, toolCalls: 9, messages: 4, context: { percent: 70, tokens: 70000, window: 100000 } }
    desk.server.publish({ ch: 'stats', payload: pushed, runtime: { sessionId: 's-2' } })
    await h.settle(1200)
    check(h.has('40%') && !h.has('70%'), `${tag} 其他会话的 stats 不影响当前详情`)
    desk.server.publish({ ch: 'stats', payload: pushed, runtime: { sessionId: 's-1' } })
    await h.waitFor(() => h.has('70%'), `${tag} 本会话 stats 推送实时更新用量`)
    check(h.has('100k tokens') && h.has('9 次工具'), `${tag} 推送的令牌与工具次数`, h.text().replace(/[· ]{10,}/g, '…').slice(0, 400))
    await h.pressLabel('收起会话详情')
    const box = h.byLabel('消息内容')[0]
    await h.typeInto(box, '你好吗')
    await h.pressLabel('发送消息')
    await h.waitFor(() => desk.calls.some((c) => c[0] === 'command' && c[1].action === 'send'), `${tag} 发送消息`)
    check(desk.calls.find((c) => c[0] === 'command' && c[1].action === 'send')[1].text === '你好吗', `${tag} 发送内容`)
    await h.waitFor(() => h.byLabel('消息内容')[0].__props.value === '', `${tag} 发送后清空输入`)
    desk.state.running = true
    desk.server.publish({ ch: 'state', payload: {}, runtime: { sessionId: 's-1' } })
    await h.waitFor(() => h.byLabel('停止当前运行').length, `${tag} 运行中出现停止按钮`)
    await h.pressLabel('停止当前运行')
    await h.waitFor(() => desk.calls.some((c) => c[0] === 'command' && c[1].action === 'abort'), `${tag} 停止发出 abort`)
    check(desk.calls.find((c) => c[0] === 'command' && c[1].action === 'abort')[1].runId === 'r1', `${tag} abort 带 runId`)
    await ctx.close()
  }

  async function flowRevokedLive() {
    const tag = '[连接中被撤销]'
    const ctx = await boot()
    const { desk, h, conn } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    await desk.devices.revoke(conn.deviceId)
    desk.server.disconnectDevice(conn.deviceId)
    await h.waitFor(() => h.has('连接电脑'), `${tag} 事件流被拒后回到配对页`, 8000)
    check(env.alerts.length === 0, `${tag} 不弹无法撤销的提示`)
    await ctx.close()
  }

  async function flowQueue() {
    const tag = '[排队消息]'
    const ctx = await boot()
    const { desk, h } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    desk.state.running = true
    desk.state.queue = { 's-1': { steering: ['先停一下，改用 pnpm'], followUp: ['做完顺便跑一下测试'] } }
    desk.state.messages = [...desk.state.messages, { id: 'a2', role: 'assistant', text: '改好了 *顺手清了缓存* 但 **还没推送**', timestamp: Date.now() - 1000 }]
    await openSession(h, '第一个会话')
    await h.waitFor(() => h.has('先停一下，改用 pnpm'), `${tag} 打开会话就显示插话`)
    check(h.has('做完顺便跑一下测试') && h.has('插话') && h.has('排队'), `${tag} 插话与排队分别标出`)
    check(h.matchLabel(/2 条消息等待发送/).length === 1, `${tag} 读屏说明等待条数`)
    check(h.has('顺手清了缓存') && !h.text().includes('*顺手清了缓存*') && !h.text().includes('**还没推送**'), `${tag} 附带说明与需要注意不再显示星号`, h.text().slice(-200))
    desk.state.queue = { 's-1': { steering: [], followUp: ['做完顺便跑一下测试'] } }
    desk.server.publish({ ch: 'queue', payload: {}, runtime: { sessionId: 's-1' } })
    await h.waitFor(() => !h.has('先停一下，改用 pnpm'), `${tag} 插话被消费后由 queue 推送刷新掉`)
    check(h.has('做完顺便跑一下测试'), `${tag} 剩下的排队仍在`)
    desk.state.queue = {}
    desk.server.publish({ ch: 'queue', payload: {}, runtime: { sessionId: 's-1' } })
    await h.waitFor(() => !h.has('做完顺便跑一下测试') && !h.matchLabel(/条消息等待发送/).length, `${tag} 队列清空后整块消失`)
    await ctx.close()
  }

  async function flowParity() {
    const tag = '[端差异补齐]'
    const { createHash } = await import('node:crypto')
    const question = { id: 'approval:11111111-2222-3333-4444-555555555555', sessionId: 's-1', runId: 'approval:11111111-2222-3333-4444-555555555555', method: 'confirm', sensitive: true, title: '运行危险命令', message: JSON.stringify({ kind: 'danger', tool: 'bash', detail: 'rm -rf build' }), deadline: Date.now() + 600_000 }
    question.approvalDigest = createHash('sha256').update(JSON.stringify([question.id, question.sessionId, question.runId, question.method, question.sensitive, question.title, question.message, []])).digest('hex')
    const approvals = []
    const ctx = await boot({ desktop: { tweak(handlers, state) {
      handlers.questions = async () => state.approvalOpen ? [question] : []
      handlers.humanApproval = async (id, answer) => { approvals.push({ id, ...answer }); state.approvalOpen = false; return { ok: true, data: { questionId: id } } }
    } } })
    const { desk, h } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    desk.state.messages = [
      { id: 'u1', role: 'user', text: '帮我整理数据', timestamp: Date.now() - 60_000 },
      { id: 'a1', role: 'assistant', text: '结果如下：\n| 项目 | 数值 |\n| --- | --- |\n| 访问 | 120 |\n\n```yan-stats\n{"title":"本周概览","items":[{"label":"新用户","value":"42"}]}\n```', timestamp: Date.now() - 59_000 },
      { id: 'h1', role: 'user', text: '[循环恢复 · 自动继续 1/1]\n上一轮因输出重复被安全中止。', timestamp: Date.now() - 50_000 },
      { id: 'u2', role: 'user', text: '再跑一遍统计', timestamp: Date.now() - 40_000 },
      { id: 'a2', role: 'assistant', text: '', error: 'prompt is too long: 250000 tokens > 200000 maximum context', timestamp: Date.now() - 39_000 }
    ]
    await openSession(h, '第一个会话')
    await h.waitFor(() => h.has('输出重复已中止，自动继续'), `${tag} 宿主续跑显示为短提示`)
    check(!h.has('上一轮因输出重复被安全中止'), `${tag} 不再显示宿主指令原文`)
    check(h.has('访问') && h.has('120') && !h.text().includes('| 访问 |'), `${tag} 表格按单元格显示`)
    check(h.has('本周概览') && h.has('新用户') && !h.text().includes('"items"'), `${tag} yan-stats 显示为可读的标题与数值`)
    check(h.has('上下文超出模型上限'), `${tag} 错误按类型给出标题`)
    await h.pressText('重试')
    await h.waitFor(() => desk.calls.some((c) => c[0] === 'command' && c[1].action === 'send'), `${tag} 重试发出消息`)
    check(desk.calls.find((c) => c[0] === 'command' && c[1].action === 'send')[1].text === '再跑一遍统计', `${tag} 重试重发的是出错前的那条消息`)
    await h.pressText('压缩上下文')
    await h.waitFor(() => desk.calls.some((c) => c[0] === 'compact'), `${tag} 上下文超限时可直接压缩`)
    desk.state.running = true
    desk.server.publish({ ch: 'state', payload: {}, runtime: { sessionId: 's-1' } })
    await h.waitFor(() => h.byLabel('停止当前运行').length, `${tag} 进入运行中`)
    await h.typeInto(h.byLabel('消息内容')[0], '顺便看下日志')
    await h.pressLabel('发送消息')
    await h.waitFor(() => desk.calls.some((c) => c[0] === 'command' && c[1].action === 'send' && c[1].text === '顺便看下日志'), `${tag} 运行中发送`)
    check(desk.calls.find((c) => c[0] === 'command' && c[1].text === '顺便看下日志')[1].mode === 'steer', `${tag} 运行中发送按插话送达`)
    desk.state.approvalOpen = true
    desk.server.publish({ ch: 'approval', payload: {}, runtime: { sessionId: 's-1' } })
    await h.waitFor(() => h.has('本会话内都允许'), `${tag} 审批卡提供「本会话内都允许」`)
    await h.pressText('本会话内都允许')
    await h.waitFor(() => approvals.length === 1, `${tag} 审批已发出`)
    check(approvals[0].confirmed === true && approvals[0].scope === 'session', `${tag} 审批带上本会话范围`, JSON.stringify(approvals[0]))
    await ctx.close()
  }

  return [
    ['实时事件与发送', flowLive],
    ['端差异补齐', flowParity],
    ['排队消息', flowQueue],
    ['连接中被撤销', flowRevokedLive]
  ]
}
