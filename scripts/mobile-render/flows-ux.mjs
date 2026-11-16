export function uxFlows({ boot, openSession, check, env: envRef }) {
  async function flowTimelineUx() {
    const tag = '[消息流体验]'
    const ctx = await boot()
    const { desk, h } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    const at = Date.now()
    desk.state.messages = [
      { id: 'u1', role: 'user', text: '跑一下测试', timestamp: at - 90_000 },
      { id: 'a1', role: 'assistant', text: '先说一半', error: 'overloaded_error: 529', timestamp: at - 89_000 },
      { id: 'a2', role: 'assistant', toolCalls: [
        { id: 't1', name: 'bash', status: 'ok', args: { command: 'npm test' }, output: '3 passed', startedAt: at - 80_000, endedAt: at - 70_000 },
        { id: 't2', name: 'edit', status: 'error', args: { path: 'a.ts' }, output: 'boom', startedAt: at - 69_000, endedAt: at - 68_000 }
      ], timestamp: at - 68_000 },
      { id: 'a3', role: 'assistant', text: '全部通过', timestamp: at - 60_000 },
      { id: 'b1', role: 'bash', text: 'npm run lint', bash: { command: 'npm run lint', exitCode: 1, cancelled: false }, toolCalls: [{ id: 'b1', name: 'bash', status: 'error', args: { command: 'npm run lint' }, output: 'lint: 2 problems' }], timestamp: at - 50_000 },
      { id: 'b2', role: 'bash', text: 'npm run dev', bash: { command: 'npm run dev', exitCode: null, cancelled: false }, toolCalls: [{ id: 'b2', name: 'bash', status: 'running', args: { command: 'npm run dev' }, output: '' }], timestamp: at - 40_000 },
      { id: 'u2', role: 'user', text: '带图重试', images: [{ mimeType: 'image/png' }], timestamp: at - 30_000 },
      { id: 'a4', role: 'assistant', text: '', error: 'prompt is too long: 250000 tokens > 200000 maximum context', timestamp: at - 29_000 }
    ]
    desk.state.queue = { 's-1': { steering: ['[循环恢复 · 自动继续 1/1]\n上一轮因输出重复被安全中止。'], followUp: ['做完顺便跑一下测试'] } }
    await openSession(h, '第一个会话')
    await h.waitFor(() => h.has('全部通过'), `${tag} 历史显示`)

    check(h.has('模型请求出错，已自动重试'), `${tag} 重试成功的模型错误显示为短提示`)
    check(!h.has('先说一半') && !h.has('overloaded_error: 529'), `${tag} 失败那条的半截文字与原始错误默认不占位`)
    await h.pressText('已自动重试')
    check(h.has('overloaded_error: 529'), `${tag} 点开短提示可看原始错误`)
    const retryButtons = h.pressables().filter((n) => n.textContent === '重试')
    check(retryButtons.length === 1, `${tag} 只有最后一次真正失败的回合有重试按钮`, String(retryButtons.length))

    check(h.matchLabel(/^1 条消息等待发送/).length === 1 && !h.has('上一轮因输出重复被安全中止'), `${tag} 排队区不显示宿主续跑指令`)

    check(h.has('npm run lint') && !h.has('lint: 2 problems'), `${tag} ! 命令默认只显示命令行`)
    await h.pressText('npm run lint')
    check(h.has('lint: 2 problems'), `${tag} 点开 ! 命令显示的是输出，不是命令本身`)
    const running = h.byText('npm run dev')[0]
    check(!!running && running.__props.disabled === true, `${tag} 运行中且没有输出的 ! 命令不可展开`)

    await h.pressLabel(/^过程，/)
    check(h.byLabel('bash npm test，完成').length === 1, `${tag} 成功的工具行读屏带结果`, h.all('[aria-label]').map((n) => n.getAttribute('aria-label')).join('|'))
    check(h.byLabel('edit a.ts，失败').length === 1, `${tag} 失败的工具行读屏带结果`)

    await h.press(retryButtons[0])
    await h.waitFor(() => h.has('这条消息带图片'), `${tag} 带图片的消息不静默丢图重试`)
    check(!desk.calls.some((c) => c[0] === 'command' && c[1].action === 'send'), `${tag} 带图重试不发请求`)
    check(h.all('[data-role="alert"]').some((n) => n.textContent.includes('这条消息带图片')), `${tag} 失败提示是读屏可播报的警示`)
    await ctx.close()
  }

  async function flowMedia() {
    const tag = '[图片与成果]'
    const ctx = await boot()
    const { desk, h } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    const at = Date.now()
    desk.state.messages = [
      { id: 'u1', role: 'user', text: '看图', images: [{ mimeType: 'image/png' }], timestamp: at - 60_000 },
      { id: 'a1', role: 'assistant', text: '写好了', artifacts: [{ id: 'x1', filename: 'notes.txt', mediaType: 'text/plain', kind: 'code', bytes: 20 }], timestamp: at - 50_000 }
    ]
    await openSession(h, '第一个会话')
    await h.waitFor(() => h.byLabel('图片加载失败，点按重试').length, `${tag} 图片取不到时显示可重试的占位`)
    await h.pressLabel('图片加载失败，点按重试')
    await h.waitFor(() => h.byLabel('图片加载失败，点按重试').length === 1, `${tag} 点按后重新加载，仍失败则回到占位`)
    await h.pressText('notes.txt')
    await h.waitFor(() => h.has('读取成果失败'), `${tag} 成果读取失败显示原因`)
    check(!h.has('读取中…'), `${tag} 失败后不再同时显示读取中`)
    check(h.all('[data-role="alert"]').some((n) => n.textContent.includes('读取成果失败')), `${tag} 成果读取失败是读屏可播报的警示`)
    await ctx.close()
  }

  async function flowPairingLost() {
    const tag = '[配对失效提示]'
    const notice = '电脑已不再认这台手机'
    const http = await boot()
    await http.desk.devices.revoke(http.conn.deviceId)
    await http.h.pressLabel('刷新会话')
    await http.h.waitFor(() => http.h.has('连接电脑'), `${tag} 令牌被撤销后回到配对页`)
    check(http.h.has(notice) && http.h.all('[data-role="alert"]').some((n) => n.textContent.includes(notice)), `${tag} 令牌被撤销时配对页说明原因`)
    await http.close()

    const tunnel = await boot()
    await tunnel.h.waitFor(() => tunnel.h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    tunnel.desk.forgetTunnelClients()
    await tunnel.h.waitFor(() => tunnel.h.has('连接电脑'), `${tag} 加密通道被电脑拒绝后回到配对页，而不是无限重连`, 15_000)
    check(tunnel.h.has(notice), `${tag} 通道被拒时配对页说明原因`)
    check(globalThis.__keychain.entry === null, `${tag} 钥匙串已清除`)
    await tunnel.close()

    const manual = await boot()
    await manual.h.pressLabel('打开手机设置')
    await manual.h.pressLabel('解除配对')
    await manual.h.alertButton('解除配对')
    await manual.h.waitFor(() => manual.h.has('连接电脑'), `${tag} 手动解除配对回到配对页`)
    check(!manual.h.has(notice), `${tag} 手动解除配对不显示「电脑不再认」`)
    await manual.close()
  }

  async function flowTypingStable() {
    const tag = '[输入时消息行不重绘]'
    const ctx = await boot()
    const { desk, h } = ctx
    await h.waitFor(() => h.matchLabel(/已连接/).length, `${tag} 事件流连上`)
    const at = Date.now()
    desk.state.messages = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', text: `第 ${index} 条`, timestamp: at - (12 - index) * 60_000 }))
    await openSession(h, '第一个会话')
    await h.waitFor(() => h.has('第 11 条'), `${tag} 历史显示`)
    await h.settle(100)
    let meta = 0
    envRef.onText = (props) => { if (typeof props.children === 'string' && /^\d\d:\d\d$/.test(props.children)) meta++ }
    const box = h.byLabel('消息内容')[0]
    for (const value of ['a', 'ab', 'abc']) await h.typeInto(box, value)
    await h.settle(100)
    envRef.onText = undefined
    check(meta === 0, `${tag} 在输入框打字时历史消息行不重绘`, String(meta))
    await ctx.close()
  }

  async function flowSearchEmpty() {
    const tag = '[搜索无结果]'
    const ctx = await boot()
    const { h } = ctx
    await h.typeInto(h.inputs()[0], '根本不存在的会话名')
    await h.waitFor(() => h.has('没有匹配的会话'), `${tag} 无结果时给出说明`)
    await h.typeInto(h.inputs()[0], '第一个')
    await h.settle(50)
    check(!h.has('没有匹配的会话'), `${tag} 有结果时不显示说明`)
    await ctx.close()
  }

  return [
    ['消息流体验', flowTimelineUx],
    ['图片与成果', flowMedia],
    ['配对失效提示', flowPairingLost],
    ['输入时消息行不重绘', flowTypingStable],
    ['搜索无结果', flowSearchEmpty]
  ]
}
