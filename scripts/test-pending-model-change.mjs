import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
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
      export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => 'en-US' }
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
const agent = new AgentController({ cwd: root, push: (event) => events.push(event) })
agent.agentRunning = true
agent.refreshStats = async () => {}
agent.rpc = { command: async (type, payload) => {
  if (type === 'set_model') {
    if (payload.modelId === 'missing') return { success: false, error: 'missing' }
    native.model = payload.modelId === 'a' ? a : b
  }
  if (type === 'set_thinking_level') native.thinkingLevel = payload.level
  return { success: true, data: type === 'get_state' ? { ...native } : type === 'get_available_thinking_levels' ? { levels } : {} }
} }
agent.setStateFrom(native)
let checks = 0
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS', name) }
await agent.setThinking('medium')
check('运行中改档保留原档位', agent.getState().pendingModelChange?.previousThinkingLevel === 'low')
await agent.setModel('fixture', 'b')
check('再改模型时保留最初请求的模型与档位', agent.getState().pendingModelChange?.previousModel?.id === 'a' && agent.getState().pendingModelChange.previousThinkingLevel === 'low')
await agent.refreshState()
check('原生刷新不清除待切换提示', !!agent.getState().pendingModelChange)
await agent.setModel('fixture', 'a')
check('还原模型仍保留尚未还原的档位切换', !!agent.getState().pendingModelChange)
await agent.setThinking('low')
check('模型和档位均还原后取消提示', !agent.getState().pendingModelChange)
const failure = await agent.setModel('fixture', 'missing')
check('失败选择不制造待切换项', !failure.ok && !agent.getState().pendingModelChange)
await agent.setThinking('high')
agent.handleEvent({ type: 'turn_start' })
check('下一请求开始清除提示', !agent.getState().pendingModelChange)
agent.agentRunning = false
native.isStreaming = false
await agent.refreshState()
await agent.setThinking('medium')
check('空闲时切换直接生效，不显示等待', agent.getState().thinkingLevel === 'medium' && !agent.getState().pendingModelChange)
agent.agentRunning = true
await agent.setModel('fixture', 'b')
native.sessionId = 'two'
agent.setStateFrom(native)
check('待切换项不泄漏到另一会话', !agent.getState().pendingModelChange)
await agent.setThinking('high')
agent.resetSessionScope()
check('重置会话作用域清除待切换项', !agent.getState().pendingModelChange)
check('状态事件携带待切换项供后台会话同步', events.some(event => event.ch === 'state' && event.payload.pendingModelChange))
console.log(`${checks}/${checks} passed`)
