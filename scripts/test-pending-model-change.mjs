import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

await mkdir('.tmp/pending-model-change', { recursive: true })
const root = await mkdtemp(resolve('.tmp/pending-model-change/run-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
const outfile = join(root, 'fixture.mjs')
await build({
  stdin: { contents: "export { AgentController } from './src/main/agent.ts'", resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{ name: 'electron-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
      export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => 'zh-CN' }
      export class BrowserWindow {}
      export const session = { fromPartition: () => ({}) }
    ` }))
  } }]
})
const { AgentController } = await import(pathToFileURL(outfile).href)
const a = { provider: 'fixture', id: 'a', name: 'Model A', reasoning: true, contextWindow: 100000 }
const b = { ...a, id: 'b', name: 'Model B' }
const levels = ['off', 'minimal', 'low', 'medium', 'high']
const native = { sessionId: 'one', model: a, thinkingLevel: 'low', availableThinkingLevels: levels, isStreaming: true }
const events = []
let failModelSwitch = false
const prompts = []
const agent = new AgentController({ cwd: root, push: (event) => events.push(event) })
agent.agentRunning = true
agent.refreshStats = async () => {}
agent.rpc = { command: async (type, payload) => {
  if (type === 'set_model') {
    if (failModelSwitch || payload.modelId === 'missing') return { success: false, error: 'switch failed' }
    native.model = payload.modelId === 'a' ? a : b
  }
  if (type === 'set_thinking_level') native.thinkingLevel = payload.level
  if (type === 'prompt') prompts.push(payload)
  const data = type === 'get_state' ? { ...native }
    : type === 'get_available_thinking_levels' ? { levels }
    : type === 'get_available_models' ? { models: [a, b] }
    : {}
  return { success: true, data }
} }
const pendingFile = (sessionId) => join(root, 'data', 'pending-model-switch', `${sessionId}.json`)
const readPending = async (sessionId) => JSON.parse(await readFile(pendingFile(sessionId), 'utf8').catch(() => 'null'))
agent.setStateFrom(native)
let checks = 0
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS', name) }
await agent.setThinking('medium')
check('运行中改档保留原档位', agent.getState().pendingModelChange?.previousThinkingLevel === 'low')
check('运行中改档不立即改 pi', native.thinkingLevel === 'low' && agent.getState().thinkingLevel === 'medium')
await agent.setModel('fixture', 'b')
check('再改模型时保留最初请求的模型与档位', agent.getState().pendingModelChange?.previousModel?.id === 'a' && agent.getState().pendingModelChange.previousThinkingLevel === 'low')
check('运行中改模型不立即改 pi', native.model.id === 'a' && agent.getState().model?.id === 'b')
const written = await readPending('one')
check('待切换目标写给扩展', written?.provider === 'fixture' && written?.id === 'b' && written?.thinkingLevel === 'medium')
await agent.refreshState()
check('原生刷新不清除待切换提示', !!agent.getState().pendingModelChange && agent.getState().model?.id === 'b')
agent.handleEvent({ type: 'turn_start' })
check('同一用户回合的下一次模型调用不清除提示', !!agent.getState().pendingModelChange)
await agent.setModel('fixture', 'a')
check('还原模型仍保留尚未还原的档位切换', !!agent.getState().pendingModelChange)
await agent.setThinking('low')
check('模型和档位均还原后取消提示', !agent.getState().pendingModelChange && await readPending('one') === null)
const failure = await agent.setModel('fixture', 'missing')
check('失败选择不制造待切换项', !failure.ok && !agent.getState().pendingModelChange)
await agent.setThinking('high')
agent.handleEvent({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'steer' }] } })
check('插话（目标未被扩展取走）不清除提示', !!agent.getState().pendingModelChange)
await rm(pendingFile('one'), { force: true })
native.thinkingLevel = 'high'
agent.handleEvent({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'follow' }] } })
await new Promise((resolve) => setTimeout(resolve, 20))
check('后续消息开始（扩展已生效）后清除提示', !agent.getState().pendingModelChange && agent.getState().thinkingLevel === 'high')
await agent.setThinking('medium')
agent.handleEvent({ type: 'agent_end', willRetry: true })
check('运行结束但目标未被扩展取走（将重试或有排队）时保留提示', !!agent.getState().pendingModelChange)
await rm(pendingFile('one'), { force: true })
native.thinkingLevel = 'medium'
agent.handleEvent({ type: 'agent_end' })
await new Promise((resolve) => setTimeout(resolve, 20))
check('运行结束扩展已生效后清除提示，底栏与 pi 一致', !agent.getState().pendingModelChange && agent.getState().thinkingLevel === 'medium')
await agent.setModel('fixture', 'b')
agent.agentRunning = false
native.isStreaming = false
await agent.refreshState()
check('扩展未取走时保留到下一条消息前', !!agent.getState().pendingModelChange && native.model.id === 'a')
await agent.applyDeferredModelSwitch()
check('下一条消息发送前应用待切换项', native.model.id === 'b' && !agent.getState().pendingModelChange && await readPending('one') === null)
await agent.setThinking('medium')
check('空闲时切换直接生效，不显示等待', agent.getState().thinkingLevel === 'medium' && !agent.getState().pendingModelChange)
agent.agentRunning = true
await agent.setModel('fixture', 'a')
agent.agentRunning = false
native.isStreaming = false
await agent.refreshState()
check('发送前仍有待切换项', !!agent.getState().pendingModelChange)
agent.applyDeferredModelSwitch = async () => ({ ok: false, error: 'switch failed' })
const failedSend = await agent.send('hello')
check('待切换应用失败时不发 prompt、返回失败并保留草稿', !failedSend.ok && /草稿已保留/.test(failedSend.error ?? '') && prompts.length === 0)
check('待切换应用失败后提示仍保留，下一次发送会再试', !!agent.getState().pendingModelChange)
agent.agentRunning = true
await agent.setModel('fixture', 'a')
native.sessionId = 'two'
agent.setStateFrom(native)
check('待切换项不泄漏到另一会话', !agent.getState().pendingModelChange)
await agent.setThinking('high')
agent.resetSessionScope()
check('重置会话作用域清除待切换项', !agent.getState().pendingModelChange)
check('状态事件携带待切换项供后台会话同步', events.some(event => event.ch === 'state' && event.payload.pendingModelChange))
const { createTurnModelSwitch } = await import('../resources/pi-extensions/turn-model-switch.js')
const extRoot = join(root, 'ext')
const applied = []
const pi = { setModel: async (model) => { applied.push(['model', model.id]); return true }, setThinkingLevel: (level) => applied.push(['thinking', level]) }
const ext = createTurnModelSwitch(pi, extRoot)
const ctx = { sessionManager: { getSessionId: () => 's1' }, modelRegistry: { find: (provider, id) => ({ provider, id }) } }
const userMessage = (text) => ({ message: { role: 'user', content: [{ type: 'text', text }] } })
await mkdir(join(extRoot, 'pending-model-switch'), { recursive: true })
await writeFile(join(extRoot, 'pending-model-switch', 's1.json'), JSON.stringify({ provider: 'fixture', id: 'b', thinkingLevel: 'high' }))
ext.onInput({ streamingBehavior: 'steer' })
await ext.onMessageStart(userMessage('steer'), ctx)
check('扩展：插话不触发切换', applied.length === 0)
await ext.onMessageStart(userMessage('<subagent-notification id="x">'), ctx)
check('扩展：子代理通知不算用户回合', applied.length === 0)
ext.onInput({ streamingBehavior: 'followUp' })
await ext.onMessageStart(userMessage('next'), ctx)
check('扩展：后续消息开始时切换模型与档位', applied.map((item) => item.join(':')).join(',') === 'model:b,thinking:high')
await ext.onMessageStart(userMessage('again'), ctx)
check('扩展：目标只生效一次', applied.length === 2)
const writeTarget = (target) => writeFile(join(extRoot, 'pending-model-switch', 's1.json'), JSON.stringify(target))
const ended = (stopReason) => ({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', stopReason }] })
applied.length = 0
await writeTarget({ thinkingLevel: 'low' })
await ext.onAgentEnd(ended('stop'), { ...ctx, hasPendingMessages: () => true })
check('扩展：运行结束仍有排队消息时不切换', applied.length === 0)
await ext.onAgentEnd(ended('error'), { ...ctx, hasPendingMessages: () => false })
check('扩展：出错结束（可能重试）时不在 agent_end 切换', applied.length === 0)
await ext.onAgentSettled({}, { ...ctx, hasPendingMessages: () => false })
check('扩展：运行彻底结束时切换', applied.map((item) => item.join(':')).join(',') === 'thinking:low')
applied.length = 0
await writeTarget({ provider: 'fixture', id: 'a' })
await ext.onAgentEnd(ended('stop'), { ...ctx, hasPendingMessages: () => false })
check('扩展：运行结束且无排队时立即切换', applied.map((item) => item.join(':')).join(',') === 'model:a')
applied.length = 0
await writeTarget({ thinkingLevel: 'high' })
await ext.onAgentEnd(ended('aborted'), { ...ctx, hasPendingMessages: () => false })
check('扩展：停止后运行结束时切换', applied.map((item) => item.join(':')).join(',') === 'thinking:high')
console.log(`${checks}/${checks} passed`)
