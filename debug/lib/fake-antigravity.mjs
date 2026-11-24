import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...body })}\n`)
let sid = `fixture-${randomUUID().slice(0, 8)}`
const reply = (id, result) => send({ id, result })
const call = (id, method, params) => send({ id, method, params })
const update = (update, sessionId = sid) => send({ method: 'session/update', params: { sessionId, update } })
const chunk = (text, sessionId) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sessionId)
const legacy = process.argv.includes('legacy')
const noAuth = process.argv.includes('auth')
const loadOnly = process.argv.includes('load-only')
const noPlan = process.argv.includes('no-plan')
const noAuto = process.argv.includes('no-auto')
const gatewayModels = process.argv.includes('gateway-models')
const embeddedContext = process.argv.includes('embedded-context')
const startDefault = process.argv.includes('start-default')
const protocolVersion = Number(process.argv.find((arg) => arg.startsWith('--protocol='))?.split('=')[1] ?? 1)
const agentVersion = process.argv.find((arg) => arg.startsWith('--version='))?.split('=')[1]
const httpMcp = process.argv.includes('http-mcp')
const steerFixture = process.argv.includes('native-steer')
const effortFailureFile = process.argv.find((arg) => arg.startsWith('--effort-failure='))?.slice('--effort-failure='.length)
const storeDir = join(tmpdir(), 'inkstone-fake-acp-sessions')
let model = 'flash'
let effort = 'low'
let mode = startDefault || noAuto ? 'default' : 'auto'
let cwd
let promptId = null
let waiting = false
let questionWaiting = false
let elicitWaiting = false
let steerWaiting = false
let clientSupportsElicitation = false
let cancelledPrompts = 0
let mcp
let syncedMcp
let knowsFixtureCode = false
let knowsLongHistory = false
let resumedHere = false
const longHistoryReply = '历史起点 ' + 'fixture history '.repeat(7_000) + ' 历史终点'
const oversizedHistoryReply = '超限起点 ' + 'oversized history '.repeat(11_000) + ' 超限终点'
const statePath = (id) => join(storeDir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
const saveSession = () => {
  try {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(statePath(sid), JSON.stringify({ model, effort, mode, cwd, knowsFixtureCode, knowsLongHistory }), 'utf8')
  } catch {}
}
const loadSession = (id) => {
  try {
    return JSON.parse(readFileSync(statePath(id), 'utf8'))
  } catch {
    return null
  }
}
const available = [
  { value: 'flash', name: 'Gemini Flash · Fixture' },
  { value: 'pro', name: 'Gemini Pro · Fixture' },
  { value: 'third-party', name: 'Claude Sonnet · Fixture' },
  ...(gatewayModels ? [
    { value: 'gateway-a', name: 'Gateway' },
    { value: 'gateway-b', name: 'Gateway' },
    { value: 'gateway-b', name: 'Duplicate ID' },
    { value: 'gateway-c', name: 'Gateway (gateway-c)' },
  ] : []),
]
const selected = (id, category, currentValue, options) => ({ [protocolVersion === 2 ? 'configId' : 'id']: id, category, type: 'select', name: id, currentValue, options })
const option = (value, name = value) => ({ value, name })
const config = () => ({ configOptions: [
  selected('model', 'model', model, [{ group: 'gemini', name: 'Gemini', options: available }]),
  selected('approval-fixture', 'mode', mode, [option('default'), option('accept-edits'), ...(!noAuto ? [option('auto')] : []), ...(!noPlan ? [option('plan', 'Plan')] : [])]),
  ...(model === 'third-party' ? [] : [selected(`effort-${model}`, 'thought_level', effort, [{
    group: 'common', name: 'Common', options: model === 'flash' ? [option('low', 'Low'), option('high', 'High')] :
      [option('low', 'Low'), option('medium', 'Medium'), option('high', 'High'), option('xhigh', 'Extra')]
  }])])
] })
const models = () => ({ models: { currentModelId: model, availableModels: available.map(({ value, name }) => ({ modelId: value, name })) } })
const options = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
]
const askQuestion = (empty = false) => {
  questionWaiting = true
  const options = [
    { optionId: '', name: '空 ID' },
    { optionId: 'duplicate', name: '重复之一' },
    { optionId: 'duplicate', name: '重复之二' },
    ...(!empty ? [
      { optionId: 'one', kind: 'allow_once', name: '同名' },
      { optionId: 'two', kind: 'allow_always', name: '同名' },
      { optionId: 'three', kind: 'unexpected', name: '同名 (2)' },
      { optionId: 'four', name: '文字\u202e' + 'x'.repeat(550) },
      { optionId: 'five' }
    ] : [])
  ]
  call('question', 'session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'interaction_fixture', title: '选择夹具\u202e选项' }, options })
}

const permissionCalls = new Map([
  ['权限', { title: '查看夹具项目', rawInput: { path: 'README.md' } }],
  ['原生插话审批', { title: '插话后请求审批', rawInput: { path: 'fixture.txt' } }],
  ['详情缺失', { title: '查看夹具项目' }],
  ['空参数审批', { title: '查看夹具项目', rawInput: {} }],
  ['重复审批选项', { title: '查看夹具项目', rawInput: { path: 'README.md' } }],
  ['完整审批详情', { kind: 'execute', title: '查看夹具\u202e审批', locations: [{ path: 'fixture.txt' }],
    rawInput: { CommandLine: 'echo fixture', BypassSandbox: true, Args: ['first', 'second\u202ethird'] },
    content: [{ type: 'content', content: { type: 'text', text: '审批说明' } }] }],
  ['详情超限', { kind: 'edit', title: '写入大段夹具内容', rawInput: { text: 'x'.repeat(32_769) } }],
  ['检查 MCP 权限', { kind: 'other', title: 'Run mcp_inkstone-pi_start_pi_subagent', rawInput: { task: 'inspect' } }],
  ['检查命令权限', { kind: 'execute', title: 'echo fixture', rawInput: { CommandLine: 'echo fixture', BypassSandbox: true } }],
  ['检查文件权限', { kind: 'edit', title: '编辑夹具文件', locations: [{ path: 'fixture.txt' }] }]
])

for await (const line of input) {
  const { id, method, params, result, error } = JSON.parse(line)
  if (method === 'initialize') {
    clientSupportsElicitation = params?.clientCapabilities?.elicitation?.form !== undefined
    reply(id, {
      protocolVersion,
      ...(agentVersion ? { agentInfo: { name: 'fixture', version: agentVersion } } : {}),
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        ...(httpMcp ? { mcpCapabilities: { http: true } } : {}),
        promptCapabilities: { image: true, ...(embeddedContext ? { embeddedContext: true } : {}) },
        ...(loadOnly ? {} : { sessionCapabilities: { resume: {}, load: {}, close: {} } })
      }
    })
  } else if (method === 'session/new') {
    const blocked = await readFile(join(params.cwd, '.acp-fixture-login'), 'utf8').catch(() => '')
    if (noAuth || blocked === 'deny') send({ id, error: { code: -32000, message: 'Authentication required' } })
    else {
      sid = `fixture-${randomUUID().slice(0, 8)}`
      resumedHere = false
      knowsFixtureCode = false
      knowsLongHistory = false
      mcp = params.mcpServers.find(({ name }) => name === 'inkstone-pi')
      syncedMcp = params.mcpServers.find(({ name }) => name === 'sync-fixture')
      cwd = params.cwd
      saveSession()
      reply(id, { sessionId: sid, ...(legacy ? models() : config()) })
      if (!legacy) update({ sessionUpdate: 'usage_update', used: 120, size: 12000 })
    }
  } else if (method === 'session/resume' || method === 'session/load') {
    const blocked = await readFile(join(params.cwd, '.acp-fixture-login'), 'utf8').catch(() => '')
    if (noAuth || blocked === 'deny') {
      send({ id, error: { code: -32000, message: 'Authentication required' } })
      continue
    }
    const saved = loadSession(params.sessionId)
    if (process.argv.includes('wrong-resume-id') && method === 'session/resume') {
      update({ sessionUpdate: 'usage_update', used: 999, size: 20000 }, params.sessionId)
      chunk('失败续接的回放', params.sessionId)
      reply(id, { sessionId: 'different-session', ...config() })
      continue
    }
    if (!saved) {
      send({ id, error: { code: -32603, message: `Failed to read session ${params.sessionId}` } })
      continue
    }
    sid = params.sessionId
    resumedHere = true
    model = saved.model ?? model
    effort = saved.effort ?? effort
    mode = saved.mode ?? mode
    knowsFixtureCode = saved.knowsFixtureCode === true
    knowsLongHistory = saved.knowsLongHistory === true
    mcp = (params.mcpServers ?? []).find(({ name }) => name === 'inkstone-pi')
    syncedMcp = (params.mcpServers ?? []).find(({ name }) => name === 'sync-fixture')
    cwd = params.cwd
    if (method === 'session/load') {
      chunk('回放噪音不应泄漏')
      update({ sessionUpdate: 'usage_update', used: 480, size: 20000 })
    }
    reply(id, { sessionId: sid, ...(legacy ? models() : config()) })
  } else if (method === 'session/set_config_option' && params.configId === 'model' || method === 'session/set_model' && legacy) {
    model = params.value ?? params.modelId
    effort = model === 'pro' ? 'high' : 'low'
    saveSession()
    reply(id, legacy ? {} : config())
    if (!legacy) update({ sessionUpdate: 'usage_update', used: 240, size: 20000 })
  } else if (method === 'session/set_config_option' && params.configId === 'approval-fixture') {
    mode = params.value
    saveSession()
    reply(id, config())
  } else if (method === 'session/set_config_option' && params.configId === `effort-${model}`) {
    if (effortFailureFile && await unlink(effortFailureFile).then(() => true, () => false)) {
      send({ id, error: { code: -32603, message: 'Fixture effort unavailable' } })
      continue
    }
    await delay(700)
    effort = params.value
    saveSession()
    reply(id, config())
    update({ sessionUpdate: 'usage_update', used: 360, size: 20000 })
  } else if (method === 'session/prompt') {
    if (steerWaiting && steerFixture) {
      steerWaiting = false
      chunk('旧轮收尾')
      reply(promptId, { stopReason: 'end_turn', usage: { inputTokens: 10 } })
    }
    promptId = id
    const blocks = Array.isArray(params.prompt) ? params.prompt : []
    const raw = blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
    const images = blocks.filter((block) => block?.type === 'image')
    if (raw.startsWith('检查文件引用\n')) {
      chunk(JSON.stringify({ model, blocks }))
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    knowsFixtureCode ||= raw.includes('记住夹具暗号：砚石')
    const prefix = 'Current user message:\n'
    const divider = '\n\nContinue the same Inkstone conversation.'
    const text = raw.startsWith(prefix) && raw.includes(divider)
      ? raw.slice(prefix.length, raw.indexOf(divider))
      : raw.split('\nCurrent user message:\n').at(-1)
    if (text === '参数诊断' || images.some(({ mimeType, data }) => !/^image\/(png|jpeg|gif|webp)$/.test(mimeType) || typeof data !== 'string' || Buffer.from(data, 'base64').toString('base64') !== data)) {
      send({ id, error: { code: -32602, message: 'Invalid params', data: {
        message: 'Image payload must be raw Base64. Bearer fixture-secret-123',
        issues: [{ path: ['prompt', 1, 'data'], message: 'Missing image bytes' }],
        request: { text: '不能暴露的原始正文' }
      } } })
      continue
    }
    if (text === '交互提问' || text === '空交互提问' || text === '原生插话提问') {
      if (text === '原生插话提问') {
        chunk('插话首块')
        update({ sessionUpdate: 'tool_call', toolCallId: 'steer_tool', kind: 'read', status: 'pending', rawInput: { path: 'fixture.txt' } })
        update({ sessionUpdate: 'usage_update', used: 567, size: 20000 })
      }
      askQuestion(text === '空交互提问')
      continue
    }
    if (text === '原生插话阻塞') {
      steerWaiting = true
      chunk('旧轮首块')
      continue
    }
    if (text === '原生插话结束') {
      if (process.argv.includes('late-steer-error')) {
        send({ id, error: { code: -32603, message: 'INVALID_THINKING_SIGNATURE' } })
      } else {
        chunk('插话快速结束')
        reply(id, { stopReason: 'end_turn', usage: { inputTokens: 20 } })
      }
      continue
    }
    if (text === '检查 MCP 传输') {
      chunk(mcp ? mcp.type ?? 'stdio' : 'none')
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '缓存与思考' || text === '思考超出输出' || text === '显式可见输出') {
      if (text === '思考超出输出') { chunk('可见'); chunk('正文') }
      const usage = text === '缓存与思考' ? { inputTokens: 80, outputTokens: 20, cachedReadTokens: 20, thoughtTokens: 9, totalTokens: 120 }
        : text === '思考超出输出' ? { input: 80, output: 20, thought: 21 } : { outputTokens: 20, thoughtTokens: 9, visibleOutputTokens: 4 }
      reply(id, { stopReason: 'end_turn', usage })
      continue
    }
    if (text === '额度拒绝') { reply(id, { stopReason: 'refusal' }); continue }
    if (text === 'AUTH401') {
      chunk('正在重新截图。\n\n⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token.\n')
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === 'STALL') continue
    if (text.endsWith('检查续接')) {
      chunk(resumedHere ? '续接方式：原会话' : '续接方式：新会话')
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查交接') {
      chunk(raw.includes('Continue the same Inkstone conversation.') ? '交接方式：冷交接' : '交接方式：同一对话')
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text.startsWith('[模型错误恢复 · 自动继续 1/1]')) {
      chunk(`认证恢复后继续完成。${raw.includes('Continue the same Inkstone conversation.') ? '冷交接' : '原生续接'}`)
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '失效思考签名') {
      send({ id, error: { code: -32603, message: 'Provider error', data: { message: 'messages.12.content.3.thinking.signature: Field required' } } })
      continue
    }
    if (text === '错误思考签名') {
      send({ id, error: { code: -32602, message: 'messages.0.content.100: Invalid `signature` in `thinking` block' } })
      continue
    }
    if (text === '超大 ACP 行') {
      chunk('砚'.repeat(6 * 1024 * 1024))
      continue
    }
    if (text === '大工具载荷') {
      const tail = 'z'.repeat(31_995) + ' END'
      const large = 'a'.repeat(4 * 1024 * 1024) + '🙂' + tail
      const combinedOutput = 'combined output'
      update({ sessionUpdate: 'tool_call', toolCallId: 'big', title: '大载荷', status: 'in_progress', kind: 'edit',
        rawInput: { IsDaemon: true, imageUrl: 'data:image/png;base64,not-for-history',
          imageObject: { type: 'image', data: 'not-for-history', blob: 'not-for-history', mimeType: 'image/png' },
          log: 'before data:image/gif;base64,not-for-history after',
          combinedOutput, formattedOutput: combinedOutput, nested: { combined_output: 'nested', formatted_output: 'nested' }, text: large },
        rawOutput: { combined_output: combinedOutput, formattedOutput: combinedOutput } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'big', status: 'completed', content: [
        { type: 'content', content: { type: 'text', text: large } },
        { type: 'content', content: { type: 'text', text: 'data:image/jpeg;base64,not-for-history' } },
        { type: 'content', content: { type: 'image', data: 'not-for-history' } },
        { type: 'diff', path: 'big.txt', oldText: 'OLD' + 'a'.repeat(40_000), newText: 'NEW' + 'z'.repeat(40_000) }
      ] })
      call('permission', 'session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'big', title: '大载荷审批' }, options })
      waiting = true
      continue
    }
    if (images.length > 0) {
      chunk(`收到 ${images.length} 张图 · ${images[0].mimeType}${text ? ` · ${text}` : ''}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (raw.includes('structured context checkpoint summary') || raw.includes('Update the existing structured summary')) {
      if (mode !== 'plan') {
        send({ id, error: { code: -32602, message: 'Compaction expected plan mode' } })
        continue
      }
      const facts = [
        knowsFixtureCode || raw.includes('记住夹具暗号：砚石') ? '- 记住夹具暗号：砚石' : '',
        knowsLongHistory || raw.includes('历史起点') ? '- 保留长历史锚点：历史起点' : '',
        raw.includes('超限起点') ? '- 保留超限历史锚点：超限起点' : ''
      ].filter(Boolean).join('\n')
      if (process.argv.includes('summary-question')) { askQuestion(); continue }
      chunk(`## Goal\n继续当前夹具任务\n\n## Progress\n### Done\n- [x] 完成前期步骤\n\n## Facts & Details\n${facts || '- 已生成测试摘要'}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '子代理步骤') {
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '夹具子代理思考' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'sub-read', title: 'Read fixture', kind: 'read', status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-read', status: 'in_progress', rawInput: { path: 'README.md' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-read', status: 'completed', rawOutput: 'fixture tool result' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-read', status: 'completed' })
      chunk(`子代理 · ${model}/${effort}/${mode}`)
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查续接方式') {
      const cold = raw.includes('Continue the same Inkstone conversation.')
      chunk(`${resumedHere && !cold ? '原生续接' : '冷交接'} · ${sid}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '生成超限历史') {
      chunk(oversizedHistoryReply)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查超限交接') {
      chunk(raw.includes('超限起点') ? `超限压缩后交接成功 · ${mode}` : '超限交接缺失')
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '上下文超限') {
      update({ sessionUpdate: 'usage_update', used: 450_000, size: 1_000_000 })
      chunk('上下文已达 450K')
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查压缩后上下文') {
      update({ sessionUpdate: 'usage_update', used: 35_000, size: 1_000_000 })
      chunk(knowsFixtureCode ? `压缩后上下文收到 · ${model}` : '压缩后上下文丢失')
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查档位') {
      chunk(`当前档位 · ${model}/${effort}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '生成长历史' || text === '检查长历史与权限') {
      if (text === '生成长历史') {
        knowsLongHistory = true
        chunk(longHistoryReply)
      } else {
        const hasLong = (resumedHere && knowsLongHistory) || raw.includes(longHistoryReply)
        chunk(hasLong ? `完整历史收到 · ${mode}` : '长历史不完整')
      }
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查权限档') {
      chunk(`当前权限档 · ${mode}`)
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查同步 MCP') {
      try {
        if (!syncedMcp) throw new Error('未收到会话 MCP')
        const connection = syncedMcp.type === 'http' ? { url: syncedMcp.url, headers: Object.fromEntries(syncedMcp.headers.map(({ name, value }) => [name, value])) }
          : { url: syncedMcp.env.find(({ name }) => name === 'INKSTONE_PI_MCP_URL').value, headers: { Authorization: syncedMcp.env.find(({ name }) => name === 'INKSTONE_PI_MCP_AUTH').value } }
        const rpc = async (method, params) => {
          const response = await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
          const result = await response.json()
          if (result.error) throw new Error(result.error.message)
          return result.result
        }
        const tools = (await rpc('tools/list', {})).tools.map(({ name }) => name)
        if (tools.join() !== 'echo') throw new Error('隐藏的 MCP 工具被暴露')
        const result = await rpc('tools/call', { name: 'echo', arguments: { text: 'MCP 同步回执' } })
        chunk(result.content[0].text)
      } catch (error) { chunk(`MCP 同步失败 · ${error.message}`) }
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '统计数据') {
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '夹具思考' } })
      update({ sessionUpdate: 'usage_update', used: 5000, size: 20000, cost: { currency: 'USD', amount: 9 } })
      chunk('你好！\n\n')
      await delay(250)
      chunk('请问今天需要处理什么任务？')
      reply(id, { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 30, visibleOutputTokens: 20, cachedReadTokens: 10, totalTokens: 140 } })
      continue
    }
    if (text === '多步进度') {
      update({ sessionUpdate: 'plan', entries: [
        { content: '检查配置文件', status: 'in_progress', priority: 'high' },
        { content: '输出最终结论', status: 'pending', priority: 'medium' }
      ] })
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**检查项目入口**\n\n先确认配置文件。' } })
      chunk('正在检查配置文件。')
      update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', title: '读取 package.json', status: 'in_progress', rawInput: { path: 'package.json' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '{"name":"fixture"}' } }] })
      update({ sessionUpdate: 'plan', entries: [
        { content: '检查配置文件', status: 'completed', priority: 'high' },
        { content: '输出最终结论', status: 'in_progress', priority: 'medium' }
      ] })
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**整理结果**\n\n准备输出结论。' } })
      chunk('多步进度完成。')
      update({ sessionUpdate: 'plan', entries: [
        { content: '检查配置文件', status: 'completed', priority: 'high' },
        { content: '输出最终结论', status: 'completed', priority: 'medium' }
      ] })
      reply(id, { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } })
      continue
    }
    if (text === '上报文件改动') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', title: '写入夹具文件', status: 'in_progress', rawInput: { path: 'acp-edited.txt' } })
      await writeFile(join(cwd, 'acp-edited.txt'), 'one\ntwo\n')
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [
        { type: 'diff', path: 'acp-edited.txt', oldText: null, newText: 'one\ntwo\n' },
        { type: 'diff', path: '../outside.txt', oldText: null, newText: 'out\n' },
        { type: 'content', content: { type: 'text', text: '写入完成' } }
      ] })
      chunk('修改已上报')
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查上下文') {
      chunk(knowsFixtureCode ? `上下文收到 · ${model}` : '上下文缺失')
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (raw.includes('<subagent-notification') && raw.includes('ACP-WAKE')) {
      chunk('后台通知自动唤醒成功')
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '后台常驻工具' || text === '后台交互提问') {
      reply(id, { stopReason: 'end_turn' })
      setTimeout(() => {
        if (text === '后台交互提问') askQuestion()
        else {
          update({ sessionUpdate: 'tool_call', toolCallId: 'daemon', kind: 'execute', title: '夹具常驻工具', status: 'in_progress', rawInput: { IsDaemon: true } })
          chunk('常驻工具已启动')
        }
      }, 100)
      continue
    }
    if (text === '后台定时巡检') {
      chunk('已启动后台任务')
      reply(id, { stopReason: 'end_turn' })
      const timer = { toolCallId: 'scheduled-check', title: 'Run schedule', kind: 'other',
        rawInput: { DurationSeconds: 900, Prompt: '检查进度', TimerCondition: 'any' } }
      setTimeout(() => {
        update({ ...timer, sessionUpdate: 'tool_call', status: 'in_progress' })
        chunk('15 分钟后自动巡检')
        setTimeout(() => {
          update({ ...timer, sessionUpdate: 'tool_call_update', status: 'completed' })
          chunk('已巡检进度')
        }, 1000)
      }, 100)
      continue
    }
    if (text === '后台工具无回执') {
      chunk('已启动等待中的后台任务')
      reply(id, { stopReason: 'end_turn' })
      setTimeout(() => {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '检查等待中的后台工具' } })
        update({ sessionUpdate: 'tool_call', toolCallId: 'stalled-tool', kind: 'read', title: '等待夹具文件', status: 'in_progress' })
      }, 250)
      continue
    }
    if (text === '后台自唤醒') {
      chunk('已启动内部后台任务')
      reply(id, { stopReason: 'end_turn' })
      setTimeout(() => {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '检查内部后台任务结果' } })
        update({ sessionUpdate: 'tool_call', toolCallId: 'bg-check-1', kind: 'execute', title: '读取后台任务日志', status: 'in_progress', rawInput: { CommandLine: 'check-bg' } })
        setTimeout(() => {
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-check-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '45/45 PASS' } }] })
          setTimeout(() => {
            chunk('内部后台任务已完成，结果 45/45 通过。')
            update({ sessionUpdate: 'usage_update', used: 41_000, size: 1_000_000 })
          }, 60)
        }, 80)
      }, 160)
      continue
    }
    if (text === '派 Pi 子代理' || text === '后台派 Pi 子代理') {
      let transport
      try {
        if (!mcp) throw new Error('未收到委派工具')
        let url
        let rpc
        if (mcp.type === 'http') {
          url = mcp.url
          const headers = Object.fromEntries(mcp.headers.map(({ name, value }) => [name, value]))
          let n = 0
          rpc = async (method, params) => {
            const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
              body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })
            const json = await response.json()
            if (json.error) throw new Error(json.error.message)
            return json.result
          }
        } else {
          if (!mcp.command || !mcp.env) throw new Error('缺少 ACP stdio 配置')
          const env = Object.fromEntries(mcp.env.map(pair => [pair.name, pair.value]))
          url = env.INKSTONE_PI_MCP_URL
          transport = spawn(mcp.command, mcp.args, { env: { ...process.env, ...env }, windowsHide: true })
          transport.on('error', () => {})
          transport.stderr.resume()
          const lines = createInterface({ input: transport.stdout })[Symbol.asyncIterator]()
          let n = 0
          rpc = async (method, params) => {
            transport.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) + '\n')
            const { value } = await lines.next()
            if (!value) throw new Error('MCP stdio exited')
            const json = JSON.parse(value)
            if (json.error) throw new Error(json.error.message)
            return json.result
          }
        }
        if (text === '派 Pi 子代理') {
          const rejected = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) })
          if (rejected.status !== 403) throw new Error('缺少委派鉴权')
        }
        await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} })
        const tools = (await rpc('tools/list', {})).tools.map(tool => tool.name).sort().join(',')
        if (tools !== 'get_pi_subagent,start_pi_subagent') throw new Error('工具范围不符')
        const tool = (name, args) => rpc('tools/call', { name, arguments: args })
        if (text === '派 Pi 子代理' && !(await tool('get_pi_subagent', { id: 'sub-12345678' })).isError) throw new Error('陌生子代理可读')
        const item = text === '后台派 Pi 子代理' ? 'WFAGENT WFITEM=ACP-WAKE WFDELAY3' : 'WFAGENT WFITEM=ACP-FIXTURE WFDELAY10'
        const started = JSON.parse((await tool('start_pi_subagent', { task: item, model: 'fake/fake-reasoning', thinkingLevel: 'high', readOnly: true })).content[0].text)
        if (!started.id) throw new Error(started.error || '没有子代理 id')
        if (started.thinkingLevel !== 'high') throw new Error(`子代理思考档位未生效：${started.thinkingLevel ?? '缺失'}`)
        if (text === '后台派 Pi 子代理') {
          chunk(`已派发后台子代理 · ${started.id}`)
        } else {
          for (let attempt = 0; attempt < 100; attempt++) {
            const result = JSON.parse((await tool('get_pi_subagent', { id: started.id })).content[0].text)
            if (result.status === 'done' && result.finalMessage?.includes('ACP-FIXTURE')) {
              if (result.thinkingLevel !== 'high') throw new Error(`子代理结果思考档位未回传：${result.thinkingLevel ?? '缺失'}`)
              chunk('收到 Pi 子代理结果 · ' + result.finalMessage)
              break
            }
            if (result.error || attempt === 99) throw new Error(result.error ?? '未收到子代理结果')
            await new Promise(resolve => setTimeout(resolve, 150))
          }
        }
      } catch (error) {
        chunk('派发失败 · ' + error.message)
      } finally {
        transport?.stdin.end()
      }
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === '检查能力声明') {
      chunk(`elicitation=${clientSupportsElicitation}`)
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (text === 'ACP单选表单') {
      elicitWaiting = true
      call('elicit', 'elicitation/create', {
        sessionId: sid,
        mode: 'form',
        message: '请选择方案',
        requestedSchema: {
          type: 'object',
          properties: {
            q0: {
              type: 'string',
              title: '方案',
              oneOf: [
                { const: 'opt_a', title: '选项 A' },
                { const: 'opt_b', title: '选项 B' },
                { const: 'opt_c', title: '选项 C' },
                { const: 'opt_d', title: '选项 D' }
              ]
            },
            q0_other: { type: 'string', title: '其他' }
          }
        }
      })
      continue
    }
    if (text === 'ACP多选表单') {
      elicitWaiting = true
      call('elicit', 'elicitation/create', {
        sessionId: sid,
        mode: 'form',
        message: '请回答多个问题',
        requestedSchema: {
          type: 'object',
          properties: {
            q0: {
              type: 'array',
              title: '多选项',
              items: {
                anyOf: [
                  { const: 'm1', title: '标签 1' },
                  { const: 'm2', title: '标签 2' }
                ]
              }
            },
            q0_other: { type: 'string', title: '其他' },
            q1: {
              type: 'string',
              title: '单选项',
              oneOf: [
                { const: 's1', title: '同名' },
                { const: 's2', title: '同名' }
              ]
            },
            q2: { type: 'boolean', title: '确认' }
          },
          required: ['q0', 'q1']
        }
      })
      continue
    }
    if (text === 'ACP链接表单') {
      elicitWaiting = true
      call('elicit', 'elicitation/create', { sessionId: sid, mode: 'url', message: '打开外链', url: 'https://example.invalid' })
      continue
    }
    if (text === '崩溃') process.exit(3)
    if (text === '等待') { chunk('正在等待'); continue }
    const operation = permissionCalls.get(text)
    if (operation) {
      if (text === '检查 MCP 权限' && !mcp) {
        chunk('未收到 ACP MCP 注册')
        reply(id, { stopReason: 'end_turn' })
        continue
      }
      waiting = true
      const toolCall = { toolCallId: 'inspect' }
      update({ sessionUpdate: 'tool_call', ...toolCall, ...operation, status: 'pending' })
      if (text === '权限' || text === '详情缺失') {
        call('foreign', 'session/request_permission', { sessionId: 'foreign-session', toolCall, options })
        call('unsupported', 'fs/write_text_file', { sessionId: sid, path: 'not-written.txt', content: 'fixture' })
      }
      call('permission', 'session/request_permission', { sessionId: sid, toolCall,
        options: text === '重复审批选项' ? [...options, { ...options[1], optionId: 'once' }] : options })
    } else {
      chunk('不应出现', 'foreign-session')
      chunk('模拟'); chunk(`回复 · ${model}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
    }
  } else if (method === 'session/cancel') {
    cancelledPrompts++
    waiting = questionWaiting = elicitWaiting = steerWaiting = false
    saveSession()
    reply(promptId, { stopReason: 'cancelled' })
  } else if (id === 'elicit' && elicitWaiting) {
    elicitWaiting = false
    chunk(`提问表单结果 · ${JSON.stringify(result)}`)
    reply(promptId, { stopReason: 'end_turn' })
  } else if (id === 'question' && questionWaiting) {
    questionWaiting = false
    chunk(`提问结果 · ${result?.outcome?.optionId ?? 'cancelled'} · cancel=${cancelledPrompts}`)
    if (process.argv.includes('summary-question')) chunk('## Goal\n继续当前夹具任务')
    reply(promptId, { stopReason: 'end_turn' })
  } else if (id === 'foreign' && result?.outcome?.outcome !== 'cancelled') process.exit(4)
  else if (id === 'unsupported' && error?.code !== -32601) process.exit(5)
  else if (id === 'permission' && waiting) {
    waiting = false
    const selected = result?.outcome?.optionId ?? 'cancelled'
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'inspect', status: selected === 'once' ? 'completed' : 'failed' })
    chunk(`审批结果 · ${selected}`)
    reply(promptId, { stopReason: 'end_turn' })
  }
}
