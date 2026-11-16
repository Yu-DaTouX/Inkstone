import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createControlExecutor, decodeControlCommand, encodeControlCommand } = await compile('src/main/control-protocol.ts')
  const make = (overrides = {}) => {
    const log = []
    const state = { destroyed: false, blocked: false, running: true, sendResult: { ok: true } }
    const win = {
      isDestroyed: () => state.destroyed,
      getContentSize: () => [800, 600],
      getTitle: () => '砚',
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 820, height: 640 }),
      webContents: {
        sendInputEvent: (event) => log.push(['input', event.type, event.keyCode ?? `${event.x},${event.y}`]),
        insertText: async (text) => log.push(['insert', text])
      }
    }
    const port = {
      window: () => (state.noWindow ? null : win),
      showWindow: () => log.push(['show']),
      agentRunning: () => state.running,
      inputBlocked: () => state.blocked,
      sendToActive: async (text) => {
        log.push(['send', text])
        return state.sendResult
      },
      ...overrides
    }
    return { run: createControlExecutor(port), log, state }
  }
  const cmd = (action, extra = {}) => ({ requestId: '0123456789abcdef', action, ...extra })

  const a = make()
  const status = await a.run(cmd('status'))
  ok(status.ok && status.data.ready === true && status.data.contentSize.width === 800 && status.data.agentRunning === true, 'status 返回窗口与 Agent 状态')
  ok(a.log.length === 0, 'status 不显示窗口、不发输入')
  a.state.noWindow = true
  const noWin = await a.run(cmd('status'))
  ok(noWin.ok && noWin.data.ready === false && noWin.data.agentRunning === true && !('title' in noWin.data), '没有窗口时 status 只报未就绪')
  const focusNoWin = await a.run(cmd('focus'))
  ok(!focusNoWin.ok && focusNoWin.error === '砚主窗口尚未就绪', '没有窗口时其余动作拒绝')
  a.state.noWindow = false
  a.state.destroyed = true
  ok(!(await a.run(cmd('click', { x: 1, y: 1 }))).ok && a.log.length === 0, '窗口已销毁时拒绝且不发输入')

  const b = make()
  const focus = await b.run(cmd('focus'))
  ok(focus.ok && focus.data.ready && b.log.length === 1 && b.log[0][0] === 'show', 'focus 显示窗口后返回状态')

  const c = make()
  const click = await c.run(cmd('click', { x: 10, y: 20 }))
  ok(click.ok && click.data.x === 10 && click.data.y === 20, 'click 返回坐标')
  ok(JSON.stringify(c.log) === JSON.stringify([['show'], ['input', 'mouseDown', '10,20'], ['input', 'mouseUp', '10,20']]), 'click 先显示窗口再按下、抬起')
  const out = await c.run(cmd('click', { x: 800, y: 0 }))
  ok(!out.ok && out.error.includes('800×600') && c.log.length === 3, '越界坐标拒绝且不发输入')

  const d = make()
  d.state.blocked = true
  for (const action of ['click', 'type', 'key']) {
    const blocked = await d.run(cmd(action, { x: 1, y: 1, text: 'x', key: 'esc' }))
    ok(!blocked.ok && blocked.error.includes('审批'), `${action} 在有待处理审批时被拦下`)
  }
  ok(d.log.length === 0, '拦下时不显示窗口、不发输入')
  const sendWhileBlocked = await d.run(cmd('send', { text: 'hi' }))
  ok(sendWhileBlocked.ok && d.log.some((item) => item[0] === 'send'), 'send 不受审批拦截影响（与原行为一致）')

  const e = make()
  const typed = await e.run(cmd('type', { text: 'hello' }))
  ok(typed.ok && typed.data.length === 5 && JSON.stringify(e.log) === JSON.stringify([['show'], ['insert', 'hello']]), 'type 显示窗口后插入文本')
  const key = await e.run(cmd('key', { key: 'ArrowUp' }))
  ok(key.ok && key.data.key === 'ArrowUp' && e.log.at(-2)[2] === 'UP' && e.log.at(-1)[1] === 'keyUp', 'key 按受限表映射，大小写不敏感')
  const before = e.log.length
  const badKey = await e.run(cmd('key', { key: 'F5' }))
  ok(!badKey.ok && badKey.error.includes('受限导航键') && e.log.length === before, '不在表内的键拒绝且不显示窗口')

  const f = make()
  f.state.sendResult = { ok: false, error: 'pi 未运行' }
  const failed = await f.run(cmd('send', { text: 'go' }))
  ok(!failed.ok && failed.error === 'pi 未运行' && JSON.stringify(f.log) === JSON.stringify([['show'], ['send', 'go']]), 'send 先显示窗口，失败原样带回错误')
  f.state.sendResult = { ok: true }
  const sent = await f.run(cmd('send', { text: 'abc' }))
  ok(sent.ok && sent.data.length === 3, 'send 成功返回文本长度')

  const g = make({ sendToActive: async () => { throw new Error('boom') } })
  const thrown = await g.run(cmd('send', { text: 'x' }))
  ok(!thrown.ok && thrown.error === 'boom' && thrown.action === 'send', '异常转成失败回执')
  const unknown = await g.run(cmd('reboot'))
  ok(!unknown.ok && unknown.error === '未知控制动作', '未知动作拒绝')

  const decoded = decodeControlCommand(['electron', encodeControlCommand(cmd('key', { key: 'esc' }))])
  ok(decoded?.action === 'key' && decoded.key === 'esc', '编码与解码往返一致')
})
