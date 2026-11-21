import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { AntigravitySession, antigravityPrompt } = await compile('src/main/antigravity.ts')
  const longHistory = [{ role: 'user', text: '甲' + '砚'.repeat(110_000) + '乙' }, { role: 'assistant', text: '答复', thinking: 'internal thought should be omitted', toolCalls: [{ id: 'tc-1', name: 'read', status: 'ok', args: { Path: 'a.ts' }, output: 'ok', details: { antigravity: true, kind: 'read', antigravityDiffs: [{ path: 'a.ts', patch: 'huge-diff' }] }, startedAt: 1, endedAt: 2 }] }]
  const handoff = antigravityPrompt('继续', longHistory)
  ok(handoff.startsWith('Current user message:\n继续\n') && handoff.includes(longHistory[0].text) && !handoff.includes('internal thought should be omitted') && !handoff.includes('huge-diff'), '超过旧字符上限时置顶当前消息、交接完整历史并剔除 UI 冗余字段')
  const withLocalizedImage = antigravityPrompt('看图', [{ role: 'user', text: '旧图', images: [{ mimeType: 'image/png', data: '', url: 'file:///a.png' }, { mimeType: 'image/jpeg', data: '' }] }])
  ok(withLocalizedImage.includes('"url":"file:///a.png"') && !withLocalizedImage.includes('"data":""'), '交接历史保留本地图片 URL，不发送空 data 字段')
  assert.throws(() => antigravityPrompt('a'.repeat(100_001), []), /消息太长/)
  assert.throws(() => antigravityPrompt('继续', [{ role: 'user', text: '砚'.repeat(1_400_000) }]), /历史未裁剪/)
  ok(true, '分别限制新消息字符数和完整历史传输字节数')
  const { parseAntigravityQuota } = await compile('src/main/antigravity-quota.ts')
  const quota = { status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [{
    name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.925, reset_time: '2026-11-21T00:30:00Z' },
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0 },
      { id: 'disabled', name: 'Disabled', status: 'disabled', remaining_fraction: 1 },
      { id: 'missing', name: 'Missing', remaining_fraction: null },
      { id: 'invalid', name: 'Invalid', remaining_fraction: 2 }
    ]
  }] } } }
  const [group] = parseAntigravityQuota(JSON.stringify(quota))
  ok(group.models.join(',') === 'Gemini 4 Neon,Gemini 3.8 Flash' && group.windows.length === 2 &&
    group.windows[0].resetAt === Date.parse('2026-11-21T00:30:00Z') && group.windows[0].remainingFraction === 0.925 &&
    group.windows[1].remainingFraction === 0 && group.windows[1].resetAt === undefined, '官方额度 JSON 保留分组、剩余数和时间，忽略无效或禁用窗口')
  ok(parseAntigravityQuota(JSON.stringify({ ...quota, num_turns: 1 })).length === 0 &&
    parseAntigravityQuota(JSON.stringify({ ...quota, command: { ...quota.command, name: 'model' } })).length === 0, '仅接受零模型回合的 usage 命令结果')
  const cwd = process.cwd()
  const start = (...args) => {
    const child = spawn(process.execPath, [resolve('debug/lib/fake-antigravity.mjs'), ...args], { windowsHide: true })
    const session = new AntigravitySession(child, async () => { child.kill() })
    const events = []
    session.onEvent = (event) => events.push(event)
    return { session, events }
  }
  const wait = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const value = fn()
      if (value) return value
      await delay(15)
    }
    assert.fail('等待 ACP 事件超时')
  }

  const { session, events } = start()
  try {
    const models = await session.start(cwd)
    ok(models.current === 'flash' && models.available.map((m) => m.id).join() === 'flash,pro,third-party', '解析分组模型列表')
    ok(models.mode === 'default' && models.thinking.options.map((m) => m.id).join() === 'low,high', '确认默认审批并解析 CLI 思考档')
    await wait(() => session.context?.used === 120)
    ok(true, '建会话回执后一行的初始上下文已接收')
    await assert.rejects(session.selectModel('unlisted'))
    const pro = await session.selectModel('pro')
    ok(pro.current === 'pro' && pro.thinking.options.at(-1).name === 'Extra', '切换模型后读取相关档位和显示名')
    await assert.rejects(session.selectThinking('ultracode'))
    const high = await session.selectThinking('xhigh')
    ok(high.thinking.current === 'xhigh', '使用模型对应的 config ID 并读取确认回执')
    await wait(() => session.context?.used === 360)
    ok(true, '空闲时更改思考档也接收上下文')
    await assert.rejects(session.selectMode('bypass'))
    ok((await session.selectMode('plan')).modes.current === 'plan', '用真实的 CLI 配置 ID 切到计划权限档')
    await assert.rejects(session.prompt('检查权限档'), /权限档/)
    await session.prompt('检查权限档', 'pro', 'xhigh', 'plan')
    ok(events.some((event) => event.text === '当前权限档 · plan'), '仅按会话明确选定的权限档发送')
    await session.selectMode('default')
    await session.prompt('检查档位')
    ok(events.some((e) => e.text === '当前档位 · pro/xhigh'), '后续真实走 ACP 配置后的夹具档位')
    await session.prompt('统计数据')
    ok(events.some((e) => e.type === 'thought' && e.text === '夹具思考') &&
      events.some((e) => e.type === 'context' && e.used === 5000 && e.size === 20000) &&
      events.some((e) => e.type === 'usage' && e.usage.output === 30 && e.usage.cacheWrite === undefined && e.usage.cost === undefined),
    '区分思考、上下文、终态用量和缺失字段；累计费用不归给回合')
    events.length = 0
    await session.prompt('多步进度')
    const plans = events.filter((e) => e.type === 'plan')
    ok(plans.length === 3 && plans[0].entries[0].status === 'running' && plans.at(-1).entries.every((e) => e.status === 'done'), '解析 ACP plan 进度更新事件')
    events.length = 0
    await session.prompt('你好')
    ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('') === '模拟回复 · pro', '增量文本按序输出，忽略其他会话的事件')
    events.length = 0
    await session.prompt('后台自唤醒')
    await wait(() => events.some((e) => e.type === 'text' && e.text.includes('内部后台任务已完成')))
    ok(
      events.some((e) => e.type === 'thought' && e.text === '检查内部后台任务结果') &&
      events.some((e) => e.type === 'tool' && e.id === 'bg-check-1' && e.status === 'completed') &&
      events.some((e) => e.type === 'text' && e.text === '内部后台任务已完成，结果 45/45 通过。'),
      'end_turn 后 CLI 内部后台任务主动推送的思考、工具与正文不被静默丢弃'
    )
    session.cancel()
    await delay(50)
    ok(!events.some((e) => e.type === 'closed'), '非 prompt 期间取消内部后台续跑不误断整个 ACP 连接')
    events.length = 0
    await session.prompt('看这张图', 'pro', 'xhigh', 'default', [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
    ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('') === '收到 1 张图 · image/png · 看这张图', '支持发送 ACP 图片内容块')
    events.length = 0
    const pending = session.prompt('权限')
    await assert.rejects(session.prompt('重入'))
    const ask = await wait(() => events.find((e) => e.type === 'permission'))
    ok(ask.title === '查看夹具项目' && ask.detail.includes('README.md') && ask.options.map((e) => e.id).join() === 'once,deny', '显示工具详情，并移除永久授权选项')
    session.reply(ask.id, 'always')
    session.reply(ask.id, 'once')
    ok(await pending === 'end_turn' && events.some((e) => e.text === '审批结果 · once'), '拒绝伪造永久授权、只回传单次批准，并拒绝越权文件 IPC')
    const missing = session.prompt('详情缺失')
    const denyOnly = await wait(() => events.find((e) => e.type === 'permission' && e.id !== ask.id))
    ok(denyOnly.options.every((e) => !e.allow), '缺少操作详情时只允许拒绝')
    session.cancel()
    ok(await missing === 'cancelled' && events.some((e) => e.type === 'permission-cleared' && e.id === denyOnly.id), '停止回复并清除待审批')
    const crash = session.prompt('崩溃')
    await assert.rejects(crash, /断开连接/)
    ok(events.some((e) => e.type === 'closed'), '进程退出时结束待处理请求并通知界面')
  } finally { await session.close() }

  const unknown = start().session
  try {
    await unknown.start(cwd)
    ok((await unknown.selectModel('third-party')).thinking === undefined, '未公布思考档的模型清除前一模型档位')
  } finally { await unknown.close() }

  const legacy = start('legacy').session
  try {
    ok((await legacy.start(cwd)).current === 'flash' && (await legacy.selectModel('pro')).current === 'pro', '兼容旧版 ACP 模型列表和切换')
  } finally { await legacy.close() }

  const auth = start('auth').session
  try {
    await assert.rejects(auth.start(cwd), /agy acp --login/)
    ok(true, '未登录时提示使用官方 CLI 登录')
  } finally { await auth.close() }

  const probe = start().session
  try {
    const discovered = await probe.start(cwd, undefined, { discoverOnly: true })
    ok(discovered.mode === 'auto' && discovered.available.length === 3, '发现模型时只读取 CLI 配置')
    await assert.rejects(probe.prompt('未在当前会话选定自动审批档'), /权限档/)
    ok(true, '拒绝沿用 CLI 全局自动模式')
  } finally { await probe.close() }

  {
    const slowServer = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { echoed: parsed.method } }))
        }, 250)
      })
    })
    await new Promise((done) => slowServer.listen(0, '127.0.0.1', done))
    const port = slowServer.address().port
    const token = `Bearer ${'a'.repeat(64)}`
    const bridge = spawn(process.execPath, [resolve('resources/pi-extensions/antigravity-pi-mcp.mjs')], {
      env: { ...process.env, INKSTONE_PI_MCP_URL: `http://127.0.0.1:${port}/mcp`, INKSTONE_PI_MCP_AUTH: token },
      windowsHide: true
    })
    const replies = []
    const reader = createInterface({ input: bridge.stdout })
    reader.on('line', (line) => replies.push(JSON.parse(line)))
    try {
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })}\n`)
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`)
      await wait(() => replies.length === 2)
      ok(replies[0].id === 2 && !replies[0].error && replies[1].id === 1 && replies[1].result?.echoed === 'tools/call', 'MCP stdio 桥并发处理请求，慢调用不阻塞 ping 心跳', JSON.stringify(replies))
    } finally {
      bridge.stdin.end()
      await new Promise((done) => bridge.once('exit', done))
      slowServer.close()
      slowServer.closeAllConnections()
    }
  }

  {
    const { openAntigravityDelegation } = await compile('src/main/antigravity-delegation.ts')
    const controller = new AbortController()
    let mode = 'plan'
    const calls = []
    const sharedOwned = new Set()
    const bridge = await openAntigravityDelegation(
      resolve('resources/pi-extensions/antigravity-pi-mcp.mjs'),
      () => ({
        signal: controller.signal,
        mode,
        run: async (command, params) => {
          calls.push({ command, params })
          if (command === 'subagent.get') {
            return {
              summary: { id: params.id, status: 'done', latestActivity: '已完成' },
              data: { model: 'openai-codex/gpt-6.2-sol', thinkingLevel: 'high', finalMessage: '审查结论', changedFiles: ['src/a.ts'] }
            }
          }
          return { summary: { id: 'sub-11112222', status: 'running', model: params.model, thinkingLevel: params.thinkingLevel } }
        }
      }),
      { delegate: true, services: [], commandHost: { cwd: () => cwd, mcpConnectionManager: () => ({ list: () => [] }), mcpConfigError: () => undefined, permissionMode: async () => 'danger', confirmDanger: async () => null, approvalOwner: () => ({}) }, owned: sharedOwned }
    )
    try {
      const env = Object.fromEntries(bridge.configs[0].env.map(({ name, value }) => [name, value]))
      const callMcp = async (url, auth, method, params) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        })
        return (await res.json()).result
      }
      const listed = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/list', {})
      const startSchema = listed.tools.find((tool) => tool.name === 'start_pi_subagent')?.inputSchema
      ok(Array.isArray(startSchema?.properties?.thinkingLevel?.enum) && startSchema.properties.thinkingLevel.enum.includes('high') && startSchema.properties.thinkingLevel.enum.includes('max'), 'start_pi_subagent 工具模式公开合法 thinkingLevel 枚举')
      const denied = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'start_pi_subagent', arguments: { task: 'edit files' } })
      ok(denied.isError === true && calls.length === 0, 'Plan 模式下拒绝派发可写 Pi 子代理')
      const badThinking = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'start_pi_subagent', arguments: { task: 'inspect files', readOnly: true, thinkingLevel: 'turbo' } })
      ok(badThinking.isError === true && calls.length === 0, '拒绝非法 thinkingLevel 参数')
      const allowed = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'start_pi_subagent', arguments: { task: 'inspect files', model: 'openai-codex/gpt-6.2-sol', thinkingLevel: ' HIGH ', readOnly: true } })
      const startedPayload = JSON.parse(allowed.content[0].text)
      ok(!allowed.isError && calls.length === 1 && calls[0].params.thinkingLevel === 'high' && startedPayload.thinkingLevel === 'high', 'Plan 模式下允许派发只读 Pi 子代理并透传 thinkingLevel', JSON.stringify({ calls, startedPayload }))
      const fetched = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'get_pi_subagent', arguments: { id: 'sub-11112222' } })
      const fetchedPayload = JSON.parse(fetched.content[0].text)
      ok(!fetched.isError && fetchedPayload.thinkingLevel === 'high' && fetchedPayload.latestActivity === '已完成' && fetchedPayload.changedFiles?.[0] === 'src/a.ts', 'get_pi_subagent 返回思考档位、最新进度和改动文件', JSON.stringify(fetchedPayload))

      const reconnected = await openAntigravityDelegation(
        resolve('resources/pi-extensions/antigravity-pi-mcp.mjs'),
        () => ({
          signal: controller.signal,
          mode,
          run: async () => ({
            summary: { id: 'sub-11112222', status: 'done' },
            data: { model: 'openai-codex/gpt-6.2-sol', thinkingLevel: 'high', finalMessage: '压缩后可读' }
          })
        }),
        { delegate: true, services: [], commandHost: { cwd: () => cwd, mcpConnectionManager: () => ({ list: () => [] }), mcpConfigError: () => undefined, permissionMode: async () => 'danger', confirmDanger: async () => null, approvalOwner: () => ({}) }, owned: sharedOwned }
      )
      try {
        const env2 = Object.fromEntries(reconnected.configs[0].env.map(({ name, value }) => [name, value]))
        const afterReconnect = await callMcp(env2.INKSTONE_PI_MCP_URL, env2.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'get_pi_subagent', arguments: { id: 'sub-11112222' } })
        const stranger = await callMcp(env2.INKSTONE_PI_MCP_URL, env2.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'get_pi_subagent', arguments: { id: 'sub-99999999' } })
        ok(!afterReconnect.isError && JSON.parse(afterReconnect.content[0].text).finalMessage === '压缩后可读' && stranger.isError === true, 'ACP 重连或压缩后仍可读取本会话已派发的 Pi 子代理，且继续拦截陌生子代理')
      } finally {
        await reconnected.close()
      }
    } finally {
      await bridge.close()
    }
  }

  {
    const prefRoot = mkdtempSync(join(tmpdir(), 'inkstone-acp-pref-'))
    const prevYanDir = process.env.YAN_DATA_DIR
    process.env.YAN_DATA_DIR = prefRoot
    try {
      const prefs = await compile('src/main/antigravity-preferences.ts')
      await prefs.saveAntigravityPreference('sess-acp-1', { model: { id: 'gemini-4-neon', name: 'Gemini 4 Neon' } })
      const file = prefs.antigravityPreferencePath(prefRoot, 'sess-acp-1')
      ok(existsSync(file) && prefs.readAntigravityPreference('sess-acp-1')?.model.id === 'gemini-4-neon', 'Antigravity 偏好可保存并回读')
      await prefs.saveAntigravityPreference('sess-acp-1', null)
      ok(!existsSync(file) && prefs.readAntigravityPreference('sess-acp-1') === undefined, '切回 Pi 时删除偏好文件，不残留 null 文件')
    } finally {
      if (prevYanDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prevYanDir
      rmSync(prefRoot, { recursive: true, force: true })
    }
  }

  {
    const { groupIntoTurns } = await compile('src/shared/turns.ts')
    const { projectSessionMetrics } = await compile('src/shared/session-metrics.ts')
    const { toolCategory } = await compile('src/renderer/src/features/session/tool-run-model.ts')
    const { extractGeminiProgressHeadings, splitTurnProcess, withGeminiProgressNotes } = await compile('src/renderer/src/features/session/turn-process.ts')

    ok(
      toolCategory({ name: '读取配置', args: {}, details: { antigravity: true, kind: 'read' } }) === 'read' &&
      toolCategory({ name: '执行测试', args: {}, details: { antigravity: true, kind: 'execute' } }) === 'command' &&
      toolCategory({ name: '新建文件', args: {}, details: { antigravity: true, kind: 'edit', antigravityDiffs: [{ status: 'created' }] } }) === 'create',
      'ACP 工具按 details.kind 正确归类到过程摘要'
    )

    const multiStep = [
      { id: 'u1', role: 'user', text: '检查项目', timestamp: 1000 },
      { id: 'a1', role: 'assistant', model: 'antigravity/gemini-4-neon', text: '正在检查配置。', thinking: '**检查配置**\n\n先读 package.json', toolCalls: [{ id: 't1', name: '读取 package.json', status: 'ok', args: {}, details: { antigravity: true, kind: 'read' } }], timestamp: 1001 },
      { id: 'a2', role: 'assistant', model: 'antigravity/gemini-4-neon', text: '检查完成。', antigravity: { usage: { input: 80, output: 20, cacheRead: 20, cacheWrite: 0, totalTokens: 120 } }, turnTiming: { logicalTurnId: 'u1', startedAt: 1000, endedAt: 2000, elapsedMs: 1000, terminalReason: 'completed' }, timestamp: 1002 }
    ]
    const [_, turn] = groupIntoTurns(multiStep)
    ok(turn.kind === 'assistant' && turn.commentary.length === 1 && turn.commentary[0].text === '正在检查配置。' && turn.response?.text === '检查完成。', 'Antigravity 多步回合把工具前文本归为进度报告，最后一步为最终答复')
    const metrics = projectSessionMetrics(multiStep, null, { antigravity: true })
    ok(metrics.partial === false && metrics.total === 120 && Math.round(metrics.hitRate) === 20, 'Antigravity 多步回合的用量与缓存命中率不被中间步误判为部分数据', JSON.stringify(metrics))

    const headings = extractGeminiProgressHeadings('**检查登录逻辑**\n\n细节如下：\n```\n**代码块里的星号不是标题**\n```\n**准备修改文件**：\n继续分析')
    ok(headings.join('|') === '检查登录逻辑|准备修改文件', '从 Gemini 思考摘要提取阶段标题并忽略代码块', JSON.stringify(headings))

    const geminiSilentTools = [
      { id: 'u2', role: 'user', text: '修 bug', timestamp: 2000 },
      { id: 'g1', role: 'assistant', model: 'google/gemini-3.1-pro', text: '', thinking: '**定位根因**\n\n先读取相关文件。', toolCalls: [{ id: 'gt1', name: 'read', status: 'ok', args: { path: 'a.ts' } }], timestamp: 2001 },
      { id: 'g2', role: 'assistant', model: 'google/gemini-3.1-pro', text: '已修复。', timestamp: 2002 }
    ]
    const [, gTurn] = groupIntoTurns(geminiSilentTools)
    const gSplit = splitTurnProcess(gTurn.segments, { keepThinking: true })
    const withProgress = withGeminiProgressNotes(gSplit.process, gTurn.model)
    ok(withProgress[0].commentary.length === 1 && withProgress[0].commentary[0].text === '定位根因', 'Pi 原生 Gemini 缺少正文进度句时，从思考标题生成步骤进度报告')

    const claudeSplit = withGeminiProgressNotes(gSplit.process, 'anthropic/claude-opus-5-5')
    ok(claudeSplit[0].commentary.length === 0, '非 Gemini 模型不触发 Gemini 思考标题提取')

    const acpWithNote = splitTurnProcess(turn.segments, { keepThinking: true })
    const acpProgress = withGeminiProgressNotes(acpWithNote.process, turn.model)
    ok(acpProgress[0].commentary.length === 1 && acpProgress[0].commentary[0].text === '正在检查配置。', 'Gemini 已有正文进度句时不重复叠加思考标题')

    const { stepDecode } = await compile('src/shared/session-metrics.ts')
    const thinkingStep = {
      id: 'a-speed',
      role: 'assistant',
      model: 'antigravity/gemini-4-neon',
      text: '这是一段足够长的最终输出回复，用来验证思考档在缺少 visibleOutputTokens 时仍可回退估算输出速度。',
      thinking: '**分析**\n\n思考过程',
      generationTiming: { startEvent: 'turn_start', ttftMs: 200, decodeMs: 1200, outputDecodeMs: 500, durationMs: 1400 }
    }
    const decoded = stepDecode(thinkingStep)
    ok(decoded !== null && decoded.ms === 500 && decoded.tokens > 0, 'Antigravity 开启思考档且未单报 visibleOutputTokens 时回退 generationTiming 估算速度', JSON.stringify(decoded))

    const { classifyModelError, modelErrorCause } = await compile('src/shared/model-errors.ts')
    const { errorCardModel } = await compile('src/renderer/src/features/session/turn-lines.ts')
    const saveErr = '回复未能保存到会话：原生操作 append_antigravity_turn 超时（15000ms）'
    const saveCard = errorCardModel(saveErr)
    ok(
      classifyModelError(saveErr).kind === 'hostSave' &&
      modelErrorCause(saveErr) === 'hostSave' &&
      saveCard?.kind === 'hostSave' &&
      saveCard.actions.length === 0,
      '本地保存失败不误判为模型超时，也不诱导重跑模型',
      JSON.stringify(saveCard)
    )

    const { contextPaneData, contextPaneToolCalls } = await compile('src/renderer/src/features/workbench/context-pane-view.ts')
    const acpCtxSession = { model: { provider: 'antigravity', id: 'gemini-4-neon', name: 'Gemini 4 Neon', contextWindow: 100000 } }
    const acpCtxStats = { contextUsage: { modelKey: 'antigravity/gemini-4-neon', tokens: 25000, contextWindow: 100000, percent: 25, availability: 'known' } }
    const acpCtxMsgs = [
      { id: 'u-ctx', role: 'user', text: '分析这段代码', timestamp: 1000 },
      { id: 'a-ctx', role: 'assistant', model: 'antigravity/gemini-4-neon', text: '分析完成', toolCalls: [{ id: 'tc-1', name: 'read', args: { path: 'src/main/agent.ts' }, output: 'x'.repeat(2000), status: 'ok', details: { antigravity: true, kind: 'read' } }], timestamp: 1001 }
    ]
    const ctxData = contextPaneData({ session: acpCtxSession, stats: acpCtxStats, messages: acpCtxMsgs })
    const ctxTools = contextPaneToolCalls({ session: acpCtxSession, stats: acpCtxStats, messages: acpCtxMsgs })
    ok(ctxData.usage.known && ctxData.parts.length >= 2 && ctxData.parts.every((p) => p.approx === true) && ctxTools.length === 1, 'Antigravity 展开上下文明细展示分类估算与大工具排行', JSON.stringify({ parts: ctxData.parts, tools: ctxTools.length }))
    const ctxCapped = contextPaneData({
      session: { ...acpCtxSession, autoCompactionEnabled: true },
      stats: { contextUsage: { modelKey: 'antigravity/gemini-4-neon', tokens: 200_000, contextWindow: 1_048_576, percent: 19, availability: 'known' } },
      messages: acpCtxMsgs,
      autoCompactLimit: 400_000
    })
    ok(ctxCapped.usage.cappedByLimit && ctxCapped.usage.windowSize === 400_000 && Math.round(ctxCapped.usage.percent ?? 0) === 50, 'Antigravity 上下文同步 Inkstone 自动压缩上限（如 400K）', JSON.stringify(ctxCapped.usage))

    const { SessionItemProjector } = await compile('src/main/session-items/projector.ts')
    const projector = new SessionItemProjector()
    projector.appendPersisted({
      role: 'assistant',
      provider: 'antigravity',
      model: 'gemini-4-neon',
      content: [{ type: 'text', text: '完成' }],
      yanAntigravityTools: [{ id: 'acp-1', name: 'File /a.ts', status: 'ok', args: { Path: 'E:\\pi-desktop\\a.ts' }, details: { antigravity: true, kind: 'read' } }],
      timestamp: 1002
    })
    const persisted = projector.uiMessages()
    ok(persisted.length === 1 && persisted[0].toolCalls?.[0]?.cancelled !== true, '冷恢复持久化 Antigravity 工具不被误标为 cancelled', JSON.stringify(persisted[0]?.toolCalls))

    const { toolStepTitle } = await compile('src/renderer/src/features/session/tool-title.ts')
    const { toolRunningLabel } = await compile('src/renderer/src/features/session/tool-summary.ts')
    const acpSegs = withGeminiProgressNotes([{
      id: 's-acp-1',
      sourceMessageId: 'm-acp-1',
      thinking: "I'm thinking through how to approach this.\n\nChecking the uncommitted git diff and recent session transcript to find why images are blocked.\n\nPreparing to patch composer-submit.ts next.",
      thinkingLive: false,
      tools: [{ id: 't-1', name: 'git status', status: 'ok', args: { CommandLine: 'git status', toolSummary: 'Check git status' }, details: { antigravity: true, kind: 'execute' } }],
      texts: [],
      commentary: [],
      response: null
    }], 'antigravity/gemini-4-neon')
    ok(acpSegs[0].commentary.length === 2 && acpSegs[0].commentary[0].text.includes('Checking the uncommitted git diff'), '无粗体标题的 Antigravity 思考段在有工具调用时提取清晰进度文字', JSON.stringify(acpSegs[0].commentary))
    const ttStub = (key) => ({ stepRead: '已读取', stepReadRunning: '正在读取', stepRan: '已运行', stepRunning: '正在运行' }[key] ?? key)
    const acpReadTitle = toolStepTitle({ name: 'File /E:/pi-desktop/src/main/agent.ts', status: 'running', args: { Path: 'E:\\pi-desktop\\src\\main\\agent.ts' }, details: { antigravity: true, kind: 'read' } }, ttStub)
    const acpCmdLabel = toolRunningLabel({ id: 't-2', name: 'git status --short', status: 'running', args: { CommandLine: 'git status --short', toolSummary: 'Check git status' }, details: { antigravity: true, kind: 'execute' } }, '生成参数中', ttStub)
    ok(acpReadTitle.label === '正在读取' && acpReadTitle.meta === 'agent.ts' && acpCmdLabel === 'Check git status', 'Antigravity 工具行标题与运行中进度标签识别 kind、Path 和 toolSummary', JSON.stringify({ acpReadTitle, acpCmdLabel }))
  }

  {
    const bridgeMod = await import(new URL('../resources/pi-extensions/native-session-bridge.js', import.meta.url))
    const { NativeSessionRuntime } = await compile('src/main/native-session-runtime.ts')
    const { YAN_DIR } = await compile('src/main/paths.ts')
    const prevYanDir = process.env.YAN_DATA_DIR
    process.env.YAN_DATA_DIR = YAN_DIR
    let handler
    let leaf = null
    const appended = []
    const emitted = []
    const piStub = {
      on() {},
      registerCommand(_name, spec) { handler = spec.handler },
      setLabel() {}
    }
    const prevBridgeEnv = process.env.YAN_NATIVE_BRIDGE
    process.env.YAN_NATIVE_BRIDGE = '1'
    bridgeMod.default(piStub)
    const runtime = new NativeSessionRuntime({
      async command(_type, payload) {
        const argText = String(payload?.message ?? '').replace(/^\/__inkstone_native\s+/, '')
        const ctx = {
          isIdle: () => true,
          ui: { notify: (msg) => { emitted.push(msg); runtime.handleNotify(msg) } },
          sessionManager: {
            getSessionId: () => 'sess-big-1',
            getLeafId: () => leaf,
            resetLeaf: () => { leaf = null },
            branch: (id) => { leaf = id },
            appendMessage: (msg) => {
              const id = `entry-${appended.length + 1}`
              appended.push({ id, msg })
              leaf = id
              return id
            }
          },
          navigateTree: async (targetId) => { leaf = targetId; return { cancelled: false } }
        }
        void handler(argText, ctx)
        return { success: true, data: { disposition: 'handled' } }
      }
    }, 5_000)
    try {
      runtime.handleNotify(bridgeMod.buildReceipt({ id: 'hello-1', op: 'hello', ok: true, result: { capabilities: ['append_antigravity_turn'] } }))
      const hugeTools = Array.from({ length: 150 }, (_, i) => ({
        id: `tool-${i}`,
        name: `read_file_${i}`,
        status: 'ok',
        args: { path: `src/file-${i}.ts` },
        output: 'A'.repeat(2200)
      }))
      const saved = await runtime.appendAntigravityTurn({
        sessionId: 'sess-big-1',
        user: '超大回合测试',
        userImages: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        steps: [{ text: '完成了 150 次工具调用', tools: hugeTools, genTiming: { startEvent: 'turn_start', ttftMs: 100, decodeMs: 600, outputDecodeMs: 400, durationMs: 700 }, timestamp: 2000 }],
        model: 'gemini-4-neon',
        startedAt: 1000,
        endedAt: 2000,
        status: 'stop'
      })
      const userEntry = appended.find((e) => e.id === saved.userId)?.msg
      const assistantEntry = appended.find((e) => e.id === saved.assistantId)?.msg
      ok(
        appended.length === 2 &&
        Array.isArray(userEntry?.content) && userEntry.content.some((c) => c.type === 'image') &&
        assistantEntry?.yanAntigravityTools?.length === 150 &&
        assistantEntry?.yanAntigravityGenTiming?.outputDecodeMs === 400,
        '超大回合（> 256 KB、150 次工具调用）经临时文件成功落盘并保存图片与速度计时',
        JSON.stringify({ saved, count: appended.length })
      )

      const contSaved = await runtime.appendAntigravityTurn({
        sessionId: 'sess-big-1',
        continuation: true,
        steps: [{ text: '后台续跑完成', timestamp: 2500 }],
        model: 'gemini-4-neon',
        startedAt: 2100,
        endedAt: 2500,
        status: 'stop'
      })
      ok(
        appended.length === 3 &&
        contSaved.userId === undefined &&
        appended[2].msg.role === 'assistant' &&
        appended[2].msg.content?.[0]?.text === '后台续跑完成',
        'append_antigravity_turn 支持无伪造用户消息的助手续跑落盘',
        JSON.stringify(contSaved)
      )

      let errWithId
      try {
        const oversized = Buffer.from(JSON.stringify({ v: 1, host: 'inkstone', id: 'req-oversized-1', op: 'noop', args: { pad: 'x'.repeat(300_000) } }), 'utf8').toString('base64url')
        bridgeMod.parseEnvelope(oversized)
      } catch (err) {
        errWithId = err
      }
      ok(errWithId?.requestId === 'req-oversized-1', 'parseEnvelope 超限时仍能提取原请求 ID，避免丢回执假超时', String(errWithId?.requestId))
    } finally {
      if (prevBridgeEnv === undefined) delete process.env.YAN_NATIVE_BRIDGE
      else process.env.YAN_NATIVE_BRIDGE = prevBridgeEnv
      if (prevYanDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prevYanDir
    }
  }

  {
    const compactMod = await compile('src/main/antigravity-compact.ts')
    const { readSessionMessages } = await compile('src/main/session-reader.ts')
    const { measuredAfterCompaction } = await compile('src/main/compaction.ts')
    const { contextUsageSummary } = await compile('src/renderer/src/features/workbench/context-pane-view.ts')
    const msgs = [
      { id: 'm1', entryId: 'e1', role: 'user', text: '先读 README 并分析架构', timestamp: 1000 },
      { id: 'm2', entryId: 'e2', role: 'assistant', model: 'antigravity/pro', text: 'x'.repeat(90_000), timestamp: 1001 },
      { id: 'm3', entryId: 'e3', role: 'user', text: '继续修第二个问题', timestamp: 1002 },
      { id: 'm4', entryId: 'e4', role: 'assistant', model: 'antigravity/pro', text: '已完成', antigravity: { context: { used: 420_000, size: 1_000_000 } }, timestamp: 1003 }
    ]
    const plan = compactMod.planAntigravityCompaction(msgs, { keepRecentTokens: 20_000 })
    ok(plan.ok && plan.toSummarize.length === 2 && plan.kept.length === 2 && plan.firstKeptEntryId === 'e3', 'Antigravity 压缩规划按最近 token 预算并对齐用户回合边界', JSON.stringify({ toSum: plan.toSummarize?.length, firstKept: plan.firstKeptEntryId }))

    const singleHuge = [
      { id: 'm1', entryId: 'e1', role: 'user', text: '一个超长任务', timestamp: 1000 },
      { id: 'm2', entryId: 'e2', role: 'assistant', model: 'antigravity/pro', text: 'y'.repeat(120_000), timestamp: 1001 }
    ]
    const fullPlan = compactMod.planAntigravityCompaction(singleHuge, { keepRecentTokens: 20_000 })
    ok(fullPlan.ok && fullPlan.toSummarize.length === 2 && fullPlan.kept.length === 0 && !fullPlan.firstKeptEntryId, '单回合超限时允许整段压缩而不拒绝', JSON.stringify({ toSum: fullPlan.toSummarize?.length, kept: fullPlan.kept?.length }))

    const chunks = compactMod.serializeCompactChunks(msgs, 40_000)
    ok(chunks.length >= 2 && chunks.every((chunk) => chunk.length <= 40_000), '压缩分块把超大消息切分在块上限之内', String(chunks.length))
    ok(compactMod.detectCompactLanguage(msgs)?.includes('Chinese'), '根据用户消息识别中文压缩摘要语言')

    const withSummary = antigravityPrompt('继续', plan.kept, '## Goal\n修好压缩')
    ok(withSummary.includes('<prior-compaction-summary>\n## Goal\n修好压缩\n</prior-compaction-summary>') && withSummary.includes('继续修第二个问题') && !withSummary.includes('先读 README'), '交接提示词只携带压缩摘要与保留消息', withSummary.slice(0, 120))
    const summaryOnly = antigravityPrompt('继续', [], '## Goal\n全部已压缩')
    ok(summaryOnly.includes('<prior-compaction-summary>') && !summaryOnly.includes('[]'), '无保留消息时仅附带压缩摘要')

    const measured = measuredAfterCompaction(
      { status: 'completed', reason: 'threshold', startedAt: 1000, endedAt: 1050, beforeTokens: 450_000, afterTokens: 25_000, afterMeasured: false },
      [{ id: 'm5', entryId: 'e5', role: 'assistant', model: 'antigravity/pro', text: '下一轮', antigravity: { context: { used: 35_000, size: 1_000_000 } }, timestamp: 2000 }]
    )
    ok(measured?.afterMeasured === true && measured.afterTokens === 35_000, '压缩后下一轮 Antigravity 回合回填实测 token 数')

    const afterSummaryView = contextUsageSummary(
      {
        model: { provider: 'antigravity', id: 'pro', name: 'Gemini Pro', contextWindow: 0 },
        autoCompactionEnabled: true,
        lastCompaction: { status: 'completed', reason: 'manual', startedAt: 1000, endedAt: 1050, beforeTokens: 450_000, afterTokens: 24_000, afterMeasured: false }
      },
      { contextUsage: { modelKey: 'antigravity/pro', tokens: null, contextWindow: 1_000_000, percent: null, availability: 'known' } },
      400_000
    )
    ok(afterSummaryView.known && afterSummaryView.estimated && afterSummaryView.tokens === 24_000 && afterSummaryView.windowSize === 400_000, 'Antigravity 压缩后立即展示估算剩余用量', JSON.stringify(afterSummaryView))

    const tmpSessionDir = mkdtempSync(join(tmpdir(), 'inkstone-acp-compact-'))
    try {
      const sessionPath = join(tmpSessionDir, 'compact.jsonl')
      const lines = [
        JSON.stringify({ type: 'session', version: 3, id: 'sess-c1', timestamp: new Date(1000).toISOString(), cwd }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: new Date(1001).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '旧问题' }], timestamp: 1001 } }),
        JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date(1002).toISOString(), message: { role: 'assistant', api: 'antigravity-acp', provider: 'antigravity', model: 'pro', content: [{ type: 'text', text: '旧回答' }], timestamp: 1002 } }),
        JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'a1', timestamp: new Date(1003).toISOString(), summary: '## Goal\n摘要内容', firstKeptEntryId: 'c1', tokensBefore: 420_000 }),
        JSON.stringify({ type: 'message', id: 'u2', parentId: 'c1', timestamp: new Date(1004).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '新问题' }], timestamp: 1004 } })
      ]
      writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8')
      const read = await readSessionMessages(sessionPath, { fullText: true })
      const sliced = compactMod.sliceInContextMessages(read.messages, read.compaction)
      ok(read.compaction?.summary === '## Goal\n摘要内容' && sliced.length === 1 && sliced[0].text === '新问题', 'readSessionMessages 提取活动分支压缩摘要并准确切片保留消息', JSON.stringify({ summary: read.compaction?.summary, sliced: sliced.map((m) => m.text) }))
    } finally {
      rmSync(tmpSessionDir, { recursive: true, force: true })
    }

    const bridgeMod = await import(new URL('../resources/pi-extensions/native-session-bridge.js', import.meta.url))
    const { NativeSessionRuntime } = await compile('src/main/native-session-runtime.ts')
    let handler
    let leaf = 'a1'
    const compactions = []
    const prevBridgeEnv = process.env.YAN_NATIVE_BRIDGE
    process.env.YAN_NATIVE_BRIDGE = '1'
    bridgeMod.default({ on() {}, registerCommand(_name, spec) { handler = spec.handler }, setLabel() {} })
    const runtime = new NativeSessionRuntime({
      async command(_type, payload) {
        const argText = String(payload?.message ?? '').replace(/^\/__inkstone_native\s+/, '')
        const ctx = {
          isIdle: () => true,
          ui: { notify: (msg) => runtime.handleNotify(msg) },
          sessionManager: {
            getSessionId: () => 'sess-c2',
            getLeafId: () => leaf,
            resetLeaf: () => { leaf = null },
            branch: (id) => { leaf = id },
            appendCompaction: (summary, firstKeptEntryId, tokensBefore, details, fromHook) => {
              const id = `comp-${compactions.length + 1}`
              compactions.push({ id, summary, firstKeptEntryId, tokensBefore, details, fromHook })
              leaf = id
              return id
            }
          },
          navigateTree: async (targetId) => { leaf = targetId; return { cancelled: false } }
        }
        void handler(argText, ctx)
        return { success: true, data: { disposition: 'handled' } }
      }
    }, 5_000)
    try {
      runtime.handleNotify(bridgeMod.buildReceipt({ id: 'hello-c', op: 'hello', ok: true, result: { capabilities: ['append_antigravity_compaction'] } }))
      const saved = await runtime.appendAntigravityCompaction({
        sessionId: 'sess-c2',
        summary: '## Goal\n压缩摘要',
        firstKeptEntryId: 'u2',
        tokensBefore: 410_000,
        details: { antigravity: true, reason: 'manual' }
      })
      ok(saved.entryId === 'comp-1' && compactions.length === 1 && compactions[0].tokensBefore === 410_000 && compactions[0].fromHook === true, 'append_antigravity_compaction 写入 Pi 原生压缩条目并同步分支', JSON.stringify(saved))
    } finally {
      if (prevBridgeEnv === undefined) delete process.env.YAN_NATIVE_BRIDGE
      else process.env.YAN_NATIVE_BRIDGE = prevBridgeEnv
    }
  }
})
