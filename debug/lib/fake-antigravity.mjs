import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
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
const storeDir = join(tmpdir(), 'inkstone-fake-acp-sessions')
let model = 'flash'
let effort = 'low'
let mode = 'auto'
let cwd
let promptId = null
let waiting = false
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
]
const selected = (id, category, currentValue, options) => ({ id, category, type: 'select', name: id, currentValue, options })
const option = (value, name = value) => ({ value, name })
const config = () => ({ configOptions: [
  selected('model', 'model', model, [{ group: 'gemini', name: 'Gemini', options: available }]),
  selected('approval-fixture', 'mode', mode, [option('default'), option('auto'), option('plan', 'Plan')]),
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

for await (const line of input) {
  const { id, method, params, result, error } = JSON.parse(line)
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
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
    await delay(700)
    effort = params.value
    saveSession()
    reply(id, config())
    update({ sessionUpdate: 'usage_update', used: 360, size: 20000 })
  } else if (method === 'session/prompt') {
    promptId = id
    const blocks = Array.isArray(params.prompt) ? params.prompt : []
    const raw = blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
    const images = blocks.filter((block) => block?.type === 'image')
    knowsFixtureCode ||= raw.includes('记住夹具暗号：砚石')
    const prefix = 'Current user message:\n'
    const divider = '\n\nContinue the same Inkstone conversation.'
    const text = raw.startsWith(prefix) && raw.includes(divider)
      ? raw.slice(prefix.length, raw.indexOf(divider))
      : raw.split('\nCurrent user message:\n').at(-1)
    if (images.length > 0) {
      chunk(`收到 ${images.length} 张图 · ${images[0].mimeType}${text ? ` · ${text}` : ''}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
      continue
    }
    if (raw.includes('structured context checkpoint summary') || raw.includes('Update the existing structured summary')) {
      const facts = [
        knowsFixtureCode || raw.includes('记住夹具暗号：砚石') ? '- 记住夹具暗号：砚石' : '',
        knowsLongHistory || raw.includes('历史起点') ? '- 保留长历史锚点：历史起点' : '',
        raw.includes('超限起点') ? '- 保留超限历史锚点：超限起点' : ''
      ].filter(Boolean).join('\n')
      chunk(`## Goal\n继续当前夹具任务\n\n## Progress\n### Done\n- [x] 完成前期步骤\n\n## Facts & Details\n${facts || '- 已生成测试摘要'}`)
      saveSession()
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
        const env = Object.fromEntries(syncedMcp.env.map(({ name, value }) => [name, value]))
        const rpc = async (method, params) => {
          const response = await fetch(env.INKSTONE_PI_MCP_URL, { method: 'POST', headers: { Authorization: env.INKSTONE_PI_MCP_AUTH, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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
        if (!mcp.command || mcp.type || !mcp.env) throw new Error('必须使用 ACP stdio 工具')
        const env = Object.fromEntries(mcp.env.map(pair => [pair.name, pair.value]))
        transport = spawn(mcp.command, mcp.args, { env: { ...process.env, ...env }, windowsHide: true })
        transport.on('error', () => {})
        transport.stderr.resume()
        const lines = createInterface({ input: transport.stdout })[Symbol.asyncIterator]()
        let n = 0
        const rpc = async (method, params) => {
          transport.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) + '\n')
          const { value } = await lines.next()
          if (!value) throw new Error('MCP stdio exited')
          const json = JSON.parse(value)
          if (json.error) throw new Error(json.error.message)
          return json.result
        }
        if (text === '派 Pi 子代理') {
          const rejected = await fetch(env.INKSTONE_PI_MCP_URL, { method: 'POST', signal: AbortSignal.timeout(5000) })
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
    if (text === '崩溃') process.exit(3)
    if (text === '等待') { chunk('正在等待'); continue }
    if (text === '权限' || text === '详情缺失' || text === '检查 MCP 权限' || text === '检查命令权限') {
      waiting = true
      if (text === '检查 MCP 权限') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'inspect', kind: 'other', title: 'Run mcp_inkstone-pi_start_pi_subagent', status: 'pending', rawInput: { task: 'inspect' } })
        call('permission', 'session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'inspect' }, options })
      } else if (text === '检查命令权限') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'inspect', kind: 'execute', title: 'npm run typecheck', status: 'pending', rawInput: { CommandLine: 'npm run typecheck' } })
        call('permission', 'session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'inspect' }, options })
      } else {
        update({ sessionUpdate: 'tool_call', toolCallId: 'inspect', title: '查看夹具项目', status: 'pending', ...(text === '权限' ? { rawInput: { path: 'README.md' } } : {}) })
        call('foreign', 'session/request_permission', { sessionId: 'foreign-session', toolCall: { toolCallId: 'inspect' }, options })
        call('unsupported', 'fs/write_text_file', { sessionId: sid, path: 'not-written.txt', content: 'fixture' })
        call('permission', 'session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'inspect' }, options })
      }
    } else {
      chunk('不应出现', 'foreign-session')
      chunk('模拟'); chunk(`回复 · ${model}`)
      saveSession()
      reply(id, { stopReason: 'end_turn' })
    }
  } else if (method === 'session/cancel') {
    waiting = false
    saveSession()
    reply(promptId, { stopReason: 'cancelled' })
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
