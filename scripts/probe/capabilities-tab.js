/* 实施-04 S7：能力设置页（cost 0）的真实 Electron / IPC / MCP 接线验收。 */
;(async () => {
  const out = []
  const ok = (condition, label, extra = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore（探针没被注入）'
  out.push('=== 能力设置页 / MCP 手动检查（S7，cost 0）===')
  for (let i = 0; i < 80 && store.getState().conn !== 'ready'; i++) await sleep(250)
  ok(store.getState().conn === 'ready', 'Pi 已就绪')

  const before = await window.yan.capabilities.snapshot()
  ok(Array.isArray(before.skills) && Array.isArray(before.servers), '能力快照形状正确')
  const fixture = before.servers.find((server) => server.id === 'fixture')
  ok(!!fixture, '快照包含当前 runner 可见的 fixture MCP')
  if (fixture) {
    ok(!Object.prototype.hasOwnProperty.call(fixture, 'command'), '快照不回传 command')
    ok(!Object.prototype.hasOwnProperty.call(fixture, 'args'), '快照不回传 args')
    ok(!Object.prototype.hasOwnProperty.call(fixture, 'env'), '快照不回传 env')
  }
  ok(before.servers.every((server) => server.status === 'disconnected'), '打开设置前不会握手连接')

  store.getState().openSettings('capabilities')
  for (let i = 0; i < 40 && !document.querySelector('[data-testid="set-capabilities"]'); i++) await sleep(100)
  ok(!!document.querySelector('[data-testid="set-capabilities"]'), '能力页真实渲染')
  ok(!!document.querySelector('[data-testid="cap-strategy-auto-connect"]'), '自动接入策略控件存在')
  ok(!!document.querySelector('[data-testid="cap-mcp-server"]'), 'MCP 服务卡片存在')

  const started = await window.yan.capabilities.verify('fixture')
  ok(started.ok && !!started.operationId, '点击检查后创建受控验证操作')
  let final = null
  if (started.operationId) {
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      final = await window.yan.capabilities.verification(started.operationId)
      if (final && final.state !== 'connecting') break
    }
  }
  ok(final?.state === 'ready', '显式检查后 MCP 连接为 ready')
  ok(final?.toolCount === 7, '显式检查刷新全部工具表', String(final?.toolCount))
  store.getState().closeSettings()
  return out.join('\n')
})()
