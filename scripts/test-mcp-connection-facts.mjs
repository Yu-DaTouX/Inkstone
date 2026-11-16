import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { McpCheckHistory, withConnectionFacts, mcpConfigFingerprint } = await compile('src/main/mcp/connection-facts.ts', { packages: 'external' })
  const { summarizeMcpStatus, setUiLang } = await compile('', {
    packages: 'external',
    stdin: {
      contents: "export { summarizeMcpStatus } from './src/renderer/src/features/settings/capabilities/mcp-status-summary.ts'\nexport { setUiLang } from './src/shared/ui-lang.ts'",
      resolveDir: process.cwd(),
      loader: 'ts'
    }
  })

  const server = (id, extra = {}) => ({ id, title: id, transport: 'stdio', enabled: true, effect: 'unknown', projectScoped: false, status: 'disconnected', toolCount: null, ownedBy: 'pi', ...extra })
  const history = new McpCheckHistory()
  const holders = [
    { legacyMcpServices: [{ serverId: 'a', status: 'ready' }, { serverId: 'b', status: 'disconnected' }] },
    { legacyMcpServices: [{ serverId: 'a', status: 'connecting' }] },
    { legacyMcpServices: null },
    { legacyMcpServices: [{ serverId: 'host-one', status: 'ready' }] }
  ]
  const scope = (projectId = 'p1', fingerprint = 'f1') => ({ projectId, fingerprint })
  const scopeOf = () => scope()
  history.record('c', { ok: true, toolCount: 3 }, scope(), 1000)
  history.record('d', { ok: false, error: 'spawn ENOENT' }, scope(), 2000)
  const merged = withConnectionFacts([server('a'), server('b'), server('c'), server('d'), server('host-one', { ownedBy: 'inkstone' })], holders, history, scopeOf)
  const by = (id) => merged.find((entry) => entry.id === id)
  ok(by('a').connectedSessions === 1, '只统计已连接（ready）的会话，连接中的不算')
  ok(by('b').connectedSessions === 0, '状态为未连接的会话不算在用')
  ok(by('c').lastCheck?.ok === true && by('c').lastCheck.toolCount === 3, '带上最近一次检查通过的结果')
  ok(by('d').lastCheck?.ok === false && by('d').lastCheck.error === 'spawn ENOENT', '带上最近一次检查失败的原因')
  ok(by('host-one').connectedSessions === undefined, '砚托管的共享连接不按会话统计')
  ok(by('b').lastCheck === undefined, '没检查过的服务没有检查记录')
  ok(withConnectionFacts([server('c')], holders, history, () => scope('p2'))[0].lastCheck === undefined, '不同项目里同名服务不互相显示检查结果')
  ok(withConnectionFacts([server('c')], holders, history, () => scope('p1', 'f2'))[0].lastCheck === undefined, '配置指纹变了（改文件或电脑操作开关）后，旧的检查结果不再显示')
  ok(withConnectionFacts([server('c')], holders, history, scopeOf)[0].lastCheck?.ok === true, '同项目同配置仍显示')
  const base = { id: 'x', transport: 'stdio', command: 'node', args: ['a.js'], env: { B: '2', A: '1' } }
  ok(mcpConfigFingerprint(base) === mcpConfigFingerprint({ ...base, env: { A: '1', B: '2' } }), '指纹与环境变量顺序无关')
  ok(mcpConfigFingerprint(base) !== mcpConfigFingerprint({ ...base, args: ['b.js'] }) && mcpConfigFingerprint(base) !== mcpConfigFingerprint({ ...base, enabled: false }), '命令、参数、启用状态改动都会改变指纹')
  ok(mcpConfigFingerprint(undefined) === 'missing', '配置不存在时有固定指纹')
  history.clear()
  ok(withConnectionFacts([server('c')], holders, history, scopeOf)[0].lastCheck === undefined, '清空后没有检查记录')
  for (let i = 0; i < 100; i++) history.record(`s${i}`, { ok: true }, scope())
  ok(history.get('s0', scope()) === undefined && history.get('s99', scope()) !== undefined, '检查记录数量有上限')

  const now = 10 * 60_000
  setUiLang('zh-CN')
  const zh = (facts) => summarizeMcpStatus(facts, now)
  ok(zh({ status: 'disconnected' }).kind === 'unchecked' && zh({ status: 'disconnected' }).short === '未检查', '没连过也没检查过：显示「未检查」，不是「未连接」')
  ok(!/未连接/.test(zh({ status: 'disconnected' }).detail), '未检查的说明里不出现「未连接」')
  ok(zh({ status: 'disconnected', connectedSessions: 2 }).kind === 'in-use-elsewhere' && /2 个会话/.test(zh({ status: 'disconnected', connectedSessions: 2 }).detail), '本会话没连但别的会话在用：显示在用的会话数')
  ok(zh({ status: 'ready', connectedSessions: 3 }).detail.includes('另有 2 个会话'), '本会话已连接时说明另有几个会话也在用')
  ok(zh({ status: 'ready', connectedSessions: 1 }).detail === '本会话已连接。', '只有本会话在用时不提别的会话')
  const passed = zh({ status: 'disconnected', lastCheck: { at: 5 * 60_000, ok: true, toolCount: 7 } })
  ok(passed.kind === 'checked-ok' && passed.detail.includes('7 个工具') && passed.detail.includes('5 分钟前'), '显示最近一次检查通过及时间')
  const failed = zh({ status: 'disconnected', lastCheck: { at: now, ok: false, error: 'spawn ENOENT' } })
  ok(failed.kind === 'checked-failed' && failed.detail.includes('spawn ENOENT') && failed.detail.includes('刚刚'), '显示最近一次检查失败的原因')
  ok(zh({ status: 'disconnected', connectedSessions: 1, lastCheck: { at: now, ok: false } }).kind === 'in-use-elsewhere', '别的会话正在用时以实际连接为准')
  ok(zh({ status: 'error' }).kind === 'error' && zh({ status: 'needs-auth' }).kind === 'needs-auth' && zh({ status: 'connecting' }).kind === 'connecting', '本会话的错误、需认证、连接中照常显示')
  const hosted = zh({ status: 'disconnected', ownedBy: 'inkstone' })
  ok(hosted.kind === 'unchecked' && /由砚托管/.test(hosted.detail) && /检查连接/.test(hosted.detail), '托管服务没连接记录时单独说明共享连接与按需建立')
  setUiLang('en-US')
  const en = summarizeMcpStatus({ status: 'disconnected' }, now)
  ok(en.short === 'Not checked' && !/Disconnected|Not connected/.test(en.detail), '英文同样显示 Not checked')
})
