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

  return [
    ['实时事件与发送', flowLive],
    ['排队消息', flowQueue],
    ['连接中被撤销', flowRevokedLive]
  ]
}
