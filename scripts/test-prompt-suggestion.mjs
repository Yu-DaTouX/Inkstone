import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  SUGGESTION_MARKER,
  SUGGESTION_STATUS_KEY,
  cleanSuggestion,
  createPromptSuggestion,
  finalReply,
  EVIDENCE_HIGH_CHARS,
  EVIDENCE_LOW_CHARS,
  SEPARATE_SYSTEM_PROMPT,
  evidenceStart,
  isCredentialLike,
  lowerReasoning,
  predictionRoute,
  suggestionInstruction,
  visibleTurns
} from '../resources/pi-extensions/prompt-suggestion.js'

let checks = 0
const ok = (condition, label) => { assert.ok(condition, label); checks++ }
const settle = () => new Promise((done) => setTimeout(done, 0))

ok(cleanSuggestion('  "\u7ee7\u7eed\u5427"  \nsecond line') === '\u7ee7\u7eed\u5427', '\u53ea\u53d6\u7b2c\u4e00\u884c\u5e76\u53bb\u6389\u5f15\u53f7')
ok(cleanSuggestion('\u300c\u7528 A\u300d') === '\u7528 A', '\u53bb\u6389\u4e2d\u6587\u5f15\u53f7')
ok(cleanSuggestion('NONE') === '' && cleanSuggestion('none.') === '' && cleanSuggestion('') === '', 'NONE \u4e0e\u7a7a\u4e32\u4e0d\u663e\u793a')
ok(cleanSuggestion('x'.repeat(201)) === '', '\u592a\u957f\u7684\u4e0d\u663e\u793a')
ok(cleanSuggestion('!npm test') === '' && cleanSuggestion('/compact') === '', '\u4ee5 ! \u6216 / \u5f00\u5934\u7684\u9884\u6d4b\u4e22\u5f03\uff1aEnter \u4f1a\u628a\u5b83\u5f53\u672c\u5730 shell \u6216\u659c\u6760\u547d\u4ee4\u76f4\u63a5\u6267\u884c')

ok(lowerReasoning('openai-responses', { reasoning: { effort: 'high', summary: 'auto' } }).reasoning.effort === 'low', 'Responses \u628a\u63a8\u7406\u6863\u964d\u5230 low')
ok(lowerReasoning('openai-completions', { reasoning_effort: 'max' }).reasoning_effort === 'low', 'Completions \u628a\u63a8\u7406\u6863\u964d\u5230 low')
const anthropicPayload = { thinking: { type: 'enabled', budget_tokens: 4000 } }
ok(lowerReasoning('anthropic-messages', anthropicPayload) === anthropicPayload, 'Anthropic \u4e0d\u52a8\u601d\u8003\u53c2\u6570\uff08\u6539\u4e86\u4f1a\u8ba9\u6d88\u606f\u7f13\u5b58\u5931\u6548\uff09')
ok(lowerReasoning('openai-responses', { input: [] }).reasoning === undefined, '\u6ca1\u6709\u63a8\u7406\u53c2\u6570\u65f6\u4e0d\u8865')

const reply = (text, stopReason = 'stop', extra = []) => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }, ...extra] })
ok(finalReply([{ role: 'user' }, reply('\u505a\u5b8c\u4e86')]) === '\u505a\u5b8c\u4e86', '\u53d6\u6700\u540e\u4e00\u6761\u52a9\u624b\u56de\u590d')
ok(finalReply([reply('x', 'error')]) === '' && finalReply([reply('x', 'aborted')]) === '', '\u51fa\u9519\u6216\u4e2d\u6b62\u7684\u4e00\u8f6e\u4e0d\u9884\u6d4b')
ok(finalReply([reply('x', 'stop', [{ type: 'toolCall' }])]) === '', '\u5e26\u5de5\u5177\u8c03\u7528\u7684\u4e0d\u7b97\u6700\u7ec8\u56de\u590d')
ok(suggestionInstruction('\u56de\u590d\u6b63\u6587').includes(SUGGESTION_MARKER) && suggestionInstruction('\u56de\u590d\u6b63\u6587').includes('<assistant-reply>\n\u56de\u590d\u6b63\u6587'), '\u6307\u4ee4\u5e26\u6807\u8bb0\u548c\u672c\u8f6e\u56de\u590d')
ok(suggestionInstruction('a'.repeat(5000)).includes('a'.repeat(4000)) && !suggestionInstruction('a'.repeat(5000)).includes('a'.repeat(4001)), '\u56de\u590d\u53ea\u5e26\u6700\u540e 4000 \u5b57')

function harness({ completeImpl, enabled = true } = {}) {
  const statuses = []
  const calls = []
  let sessionId = 's1'
  const ui = { setStatus: (key, text) => statuses.push([key, text]) }
  const registry = {
    complete: async (model, context, options) => {
      const payload = options.onPayload()
      calls.push({ model, options, payload })
      return completeImpl ? completeImpl(payload, options) : { stopReason: 'stop', content: [{ type: 'text', text: '\u63d0\u4ea4\u5427' }] }
    }
  }
  const model = { provider: 'p', id: 'm', api: 'openai-responses' }
  const ctx = { model, modelRegistry: registry, ui, sessionManager: { getSessionId: () => sessionId } }
  const suggestion = createPromptSuggestion({ enabled: () => enabled })
  const request = () => suggestion.onRequest({ payload: { input: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read' }], reasoning: { effort: 'high' } } }, ctx)
  const end = (text = '\u6539\u597d\u4e86\u3002**\u8981\u4f60\u5b9a\uff1a\u63d0\u4e0d\u63d0\u4ea4\u3002**') => suggestion.onAgentEnd({ messages: [reply(text)] }, ctx)
  const start = (prompt) => suggestion.onAgentStart({ prompt }, ctx)
  return { suggestion, statuses, calls, request, end, start, ctx, setSession: (id) => { sessionId = id } }
}

{
  const h = harness()
  h.request()
  h.end()
  await settle()
  ok(h.calls.length === 1, '\u4e00\u8f6e\u6b63\u5e38\u7ed3\u675f\u540e\u53d1\u4e00\u6b21\u9884\u6d4b\u8bf7\u6c42')
  const payload = h.calls[0].payload
  const last = payload.input.at(-1)
  ok(payload.input[0].content === 'hi' && last.role === 'user' && last.content[0].text.includes(SUGGESTION_MARKER), '\u91cd\u53d1\u4e0a\u4e00\u6b21\u8bf7\u6c42\u4f53\uff0c\u53ea\u5728\u672b\u5c3e\u8ffd\u52a0\u6307\u4ee4\uff08\u524d\u7f00\u4e0d\u53d8\u624d\u80fd\u547d\u4e2d\u7f13\u5b58\uff09')
  ok(payload.tool_choice === 'none' && payload.tools.length === 1, '\u7981\u7528\u5de5\u5177\u4f46\u4e0d\u5220\u5de5\u5177')
  ok(payload.reasoning.effort === 'low' && payload.max_output_tokens === 1024, '\u63a8\u7406\u964d\u6863\u3001\u8f93\u51fa\u6709\u4e0a\u9650')
  ok(h.calls[0].options.sessionId === 's1', '\u5e26\u4f1a\u8bdd ID\uff0c\u548c\u4e3b\u4f1a\u8bdd\u5171\u7528\u7f13\u5b58\u952e')
  ok(h.statuses.at(-1)?.[0] === SUGGESTION_STATUS_KEY && h.statuses.at(-1)?.[1] === '\u63d0\u4ea4\u5427', '\u7ed3\u679c\u5199\u8fdb\u4f1a\u8bdd\u72b6\u6001\uff0c\u7531\u5bbf\u4e3b\u63a8\u5230\u8f93\u5165\u6846')
  h.start('\u63d0\u4ea4\u5427')
  ok(h.statuses.at(-1)?.[1] === undefined, '\u4e0b\u4e00\u8f6e\u5f00\u59cb\u65f6\u6e05\u6389\u5efa\u8bae')
  ok(h.suggestion.state().ignored === 0, '\u7528\u4e86\u5efa\u8bae\u4e0d\u7b97\u5ffd\u7565')
}

{
  const h = harness()
  for (let round = 0; round < 3; round += 1) {
    h.request()
    h.end()
    await settle()
    h.start(`\u522b\u7684\u8bdd ${round}`)
  }
  ok(h.suggestion.state().ignored === 3, '\u8fde\u7eed\u4e09\u6b21\u6ca1\u7528\u8bb0\u4e3a\u5ffd\u7565')
  const before = h.calls.length
  for (let round = 0; round < 3; round += 1) {
    h.request()
    h.end()
    await settle()
    h.start(`\u8fd8\u662f\u522b\u7684 ${round}`)
  }
  ok(h.calls.length - before === 1, '\u5ffd\u7565\u591a\u4e86\u4ee5\u540e\u6bcf\u4e09\u8f6e\u53ea\u9884\u6d4b\u4e00\u6b21')
}

{
  const h = harness()
  h.start('<subagent-notification id="x">')
  h.request()
  h.end()
  await settle()
  h.start('<subagent-notification id="y" status="done">')
  ok(h.suggestion.state().ignored === 0, '\u5b50\u4ee3\u7406\u901a\u77e5\u4e0d\u7b97\u7528\u6237\u5ffd\u7565\u4e86\u5efa\u8bae')
}

{
  let release
  const h = harness({ completeImpl: () => new Promise((done) => { release = done }) })
  h.request()
  h.end()
  await settle()
  h.start('\u6211\u81ea\u5df1\u6253\u7684\u5b57')
  release({ stopReason: 'stop', content: [{ type: 'text', text: '\u665a\u5230\u7684\u5efa\u8bae' }] })
  await settle()
  ok(!h.statuses.some(([, text]) => text === '\u665a\u5230\u7684\u5efa\u8bae'), '\u65b0\u4e00\u8f6e\u5f00\u59cb\u540e\u665a\u5230\u7684\u7ed3\u679c\u4e22\u5f03')
  ok(h.calls[0].options.signal.aborted, '\u65b0\u4e00\u8f6e\u5f00\u59cb\u65f6\u4e2d\u6b62\u9884\u6d4b\u8bf7\u6c42')
}

{
  let release
  const h = harness({ completeImpl: () => new Promise((done) => { release = done }) })
  h.request()
  h.end()
  await settle()
  h.setSession('s2')
  release({ stopReason: 'stop', content: [{ type: 'text', text: '\u4e32\u4f1a\u8bdd\u7684\u5efa\u8bae' }] })
  await settle()
  ok(!h.statuses.length, '\u540c\u4e00\u8fdb\u7a0b\u5207\u5230\u522b\u7684\u4f1a\u8bdd\u540e\u4e0d\u5199\u5efa\u8bae')
}

{
  const h = harness({ completeImpl: (payload) => payload.reasoning?.effort === 'low' ? { stopReason: 'error', errorMessage: 'Unsupported value: reasoning.effort' } : { stopReason: 'stop', content: [{ type: 'text', text: '\u597d' }] } })
  h.request()
  h.end()
  await settle()
  ok(!h.suggestion.state().lowerReasoningWorks && h.suggestion.state().failures === 0, '\u964d\u6863\u88ab\u62d2\u65f6\u8bb0\u4e0b\u6765\uff0c\u4e0d\u7b97\u5931\u8d25')
  h.request()
  h.end()
  await settle()
  ok(h.calls.at(-1).payload.reasoning.effort === 'high' && h.statuses.at(-1)?.[1] === '\u597d', '\u4e4b\u540e\u4e0d\u518d\u964d\u6863\uff0c\u7167\u5e38\u51fa\u5efa\u8bae')
}

{
  const transient = harness({ completeImpl: () => ({ stopReason: 'error', errorMessage: 'HTTP 429 rate limited' }) })
  transient.request()
  transient.end()
  await settle()
  ok(transient.suggestion.state().lowerReasoningWorks && transient.suggestion.state().failures === 1, '\u9650\u6d41\u3001\u65ad\u7f51\u8fd9\u7c7b\u4e34\u65f6\u9519\u8bef\u7b97\u5931\u8d25\uff0c\u4e0d\u5f53\u6210\u964d\u6863\u88ab\u62d2')

  let failing = true
  const h = harness({ completeImpl: () => failing ? { stopReason: 'error', errorMessage: 'HTTP 503' } : { stopReason: 'stop', content: [{ type: 'text', text: '\u597d' }] } })
  const round = async () => {
    h.request()
    h.end()
    await settle()
  }
  for (let i = 0; i < 13; i += 1) await round()
  ok(h.calls.length === 4, '\u8fde\u7eed\u5931\u8d25\u4e09\u6b21\u540e\u51b7\u5374\uff1a\u4e4b\u540e\u6bcf 10 \u8f6e\u624d\u8bd5\u4e00\u6b21\uff0c\u4e0d\u6c38\u4e45\u505c\u7528')
  failing = false
  await round()
  ok(h.calls.length === 5 && h.suggestion.state().failures === 0 && h.statuses.at(-1)?.[1] === '\u597d', '\u51b7\u5374\u540e\u6210\u529f\u4e00\u6b21\u5c31\u6062\u590d\u6bcf\u8f6e\u9884\u6d4b')
  await round()
  ok(h.calls.length === 6, '\u6062\u590d\u540e\u4e0b\u4e00\u8f6e\u7167\u5e38\u9884\u6d4b')
}

{
  const h = harness()
  h.request()
  h.suggestion.reset(h.ctx.ui)
  h.end()
  await settle()
  ok(h.calls.length === 0, 'fork\u3001\u56de\u9000\u6216\u5207\u6362\u4f1a\u8bdd\u540e\u6e05\u6389\u7f13\u5b58\u7684\u8bf7\u6c42\u4f53\uff0c\u4e0d\u62ff\u65e7\u5206\u652f\u53bb\u9884\u6d4b')
  h.request()
  h.end()
  await settle()
  h.end()
  await settle()
  ok(h.calls.length === 1, '\u8bf7\u6c42\u4f53\u7528\u8fc7\u5373\u5f03\uff0c\u540c\u4e00\u6b21\u8bf7\u6c42\u4e0d\u4f1a\u89e6\u53d1\u4e24\u6b21\u9884\u6d4b')
}

{
  ok(isCredentialLike('验证码：123456') && isCredentialLike('api key = sk-abcdefghijklmnop') && isCredentialLike('483920'), '验证码、密钥、纯数字串算凭据形状')
  ok(!isCredentialLike('把 token 统计加进会话') && !isCredentialLike('跑 3 轮'), '只是提到 token 的正常句子不算')
  ok(cleanSuggestion('验证码：123456') === '' && cleanSuggestion('👌') === '' && cleanSuggestion('】【。') === '', '凭据形状、只有符号或表情的预测丢弃')
  ok(cleanSuggestion('继续推进吧。', '继续推进吧') === '' && cleanSuggestion('继续推进吧', '先别动') === '继续推进吧', '和用户上一句一样的预测丢弃')

  const registry = { find: (provider, id) => ({ provider, id, api: id.startsWith('claude') ? 'anthropic-messages' : 'openai-codex-responses' }), streamSimple: () => ({}) }
  const opus = predictionRoute({ provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages' }, registry)
  ok(opus?.model.id === 'claude-haiku-5-5' && opus.model.provider === 'anthropic' && opus.reasoning === undefined, 'Claude 主会话用同一登录下的 Haiku 5.5，不开思考')
  const gpt = predictionRoute({ provider: 'openai-codex', id: 'gpt-6', api: 'openai-codex-responses' }, registry)
  ok(gpt?.model.id === 'gpt-6-luna' && gpt.reasoning === 'low', 'GPT 主会话用 GPT-6 Luna，思考 low')
  ok(predictionRoute({ provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash', api: 'openai-completions' }, registry) === null, 'DeepSeek 等其他模型仍用同一模型重发主请求')
  ok(predictionRoute({ provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages' }, { find: () => undefined, streamSimple: () => ({}) }) === null, '找不到 Haiku（比如没登录）时退回同模型')

  const entry = (role, text) => ({ type: 'message', message: { role, content: [{ type: 'text', text }] } })
  const branch = [
    entry('user', '修一下测试'),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '我先看看。' }, { type: 'toolCall', name: 'read' }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: '文件内容很长' }] } },
    entry('assistant', '修好了，要提交吗？'),
    entry('user', '<subagent-notification>子代理完成</subagent-notification>'),
    entry('user', '[模型错误恢复 · 自动继续 1/1]\n继续'),
    { type: 'compaction', summary: '摘要' },
    entry('user', '提交吧'),
    entry('assistant', '已提交。')
  ]
  const turns = visibleTurns(branch)
  ok(turns.length === 2 && turns[0] === '[user]\n修一下测试\n\n[assistant]\n我先看看。\n\n修好了，要提交吗？', '只留用户和助手的文字，按轮合并，工具结果不带')
  ok(!turns.join('').includes('子代理完成') && !turns.join('').includes('模型错误恢复') && !turns.join('').includes('摘要'), '宿主注入的通知、续跑与压缩摘要不算用户发言')

  const big = Array.from({ length: 30 }, (_, i) => `t${i}` + 'x'.repeat(9000))
  const first = evidenceStart(big)
  const kept = (from) => big.slice(from).reduce((sum, turn) => sum + turn.length, 0)
  ok(first > 0 && kept(first) <= EVIDENCE_LOW_CHARS, '超过上限时从最早的轮次整段丢，降到下限以内')
  const grown = [...big, 'y'.repeat(9000), 'z'.repeat(9000)]
  ok(evidenceStart(grown, first) === first, '之后几轮不再挪起点，前缀不变才能命中缓存')
  ok(evidenceStart(['a', 'b'], 0) === 0 && EVIDENCE_HIGH_CHARS > EVIDENCE_LOW_CHARS, '没超上限时从头开始')

  const calls = []
  const statuses = []
  const haiku = { provider: 'anthropic', id: 'claude-haiku-5-5', api: 'anthropic-messages' }
  const sepRegistry = {
    find: (provider, id) => (id === 'claude-haiku-5-5' ? haiku : undefined),
    complete: async () => { throw new Error('同模型路径不该被调用') },
    streamSimple: (model, context, options) => {
      calls.push({ model, context, options })
      return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '提交吧。' }] }) }
    }
  }
  const sepCtx = {
    model: { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages' },
    modelRegistry: sepRegistry,
    ui: { setStatus: (key, text) => statuses.push([key, text]) },
    sessionManager: { getSessionId: () => 's9', getBranch: () => branch.slice(0, 4) }
  }
  const sep = createPromptSuggestion({ enabled: () => true })
  sep.onAgentEnd({ messages: [reply('修好了，要提交吗？')] }, sepCtx)
  await settle()
  ok(calls.length === 1 && calls[0].model === haiku, 'Claude 主会话的预测发给 Haiku，不重发主请求')
  ok(calls[0].context.systemPrompt === SEPARATE_SYSTEM_PROMPT && calls[0].context.messages.length === 1 && calls[0].context.messages[0].role === 'user', '固定说明放系统提示，每轮一条消息，只往后追加')
  ok(calls[0].options.reasoning === undefined && calls[0].options.sessionId === 's9:prompt-suggestion' && calls[0].options.maxTokens === 1024, '不开思考、独立缓存键、输出有上限')
  ok(statuses.at(-1)?.[1] === '提交吧。', '独立模型的结果照样推到输入框')
  sepCtx.sessionManager.getBranch = () => branch
  sep.onAgentEnd({ messages: [reply('已提交。')] }, sepCtx)
  await settle()
  ok(statuses.length === 1, '和用户上一句（提交吧）一样的预测不显示')
}

{
  const h = harness({ enabled: false })
  h.request()
  h.end()
  await settle()
  ok(h.calls.length === 0, '\u8bbe\u7f6e\u5173\u6389\u65f6\u4e0d\u9884\u6d4b')
  const other = harness()
  other.request()
  other.ctx.model = { provider: 'p', id: 'other', api: 'openai-responses' }
  other.end()
  await settle()
  ok(other.calls.length === 0, '\u6a21\u578b\u6362\u4e86\u5c31\u4e0d\u91cd\u53d1\u65e7\u8bf7\u6c42\u4f53')
  const errored = harness()
  errored.request()
  errored.suggestion.onAgentEnd({ messages: [reply('x', 'error')] }, errored.ctx)
  await settle()
  ok(errored.calls.length === 0, '\u51fa\u9519\u7684\u4e00\u8f6e\u4e0d\u9884\u6d4b')
}

const dir = await mkdtemp(resolve('node_modules/.prompt-suggestion-'))
try {
  const out = join(dir, 'composer-suggestion.mjs')
  await build({ entryPoints: ['src/renderer/src/features/composer/prompt-suggestion.ts'], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const ui = await import(pathToFileURL(out).href)
  ok(ui.PROMPT_SUGGESTION_STATUS_KEY === SUGGESTION_STATUS_KEY, '\u8f93\u5165\u6846\u548c\u6269\u5c55\u7528\u540c\u4e00\u4e2a\u72b6\u6001\u952e')
  const view = { suggestion: '\u63d0\u4ea4\u5427', dismissed: null, enabled: true, running: false, answering: false, value: '', attachmentCount: 0 }
  ok(ui.visibleSuggestion(view) === '\u63d0\u4ea4\u5427', '\u8f93\u5165\u6846\u7a7a\u7740\u65f6\u663e\u793a\u5efa\u8bae')
  ok(ui.visibleSuggestion({ ...view, value: 'a' }) === null && ui.visibleSuggestion({ ...view, attachmentCount: 1 }) === null, '\u6709\u5b57\u6216\u6709\u9644\u4ef6\u65f6\u4e0d\u663e\u793a')
  ok(ui.visibleSuggestion({ ...view, running: true }) === null && ui.visibleSuggestion({ ...view, answering: true }) === null, '\u8fd0\u884c\u4e2d\u6216\u5728\u7b54\u9898\u65f6\u4e0d\u663e\u793a')
  ok(ui.visibleSuggestion({ ...view, suggestion: '!rm -rf build' }) === null && ui.visibleSuggestion({ ...view, suggestion: '/new' }) === null, '\u8f93\u5165\u6846\u4e5f\u4e0d\u663e\u793a ! \u6216 / \u5f00\u5934\u7684\u5efa\u8bae\uff08\u53cc\u91cd\u4fdd\u9669\uff09')
  ok(ui.visibleSuggestion({ ...view, composing: true }) === null, '\u8f93\u5165\u6cd5\u7ec4\u5b57\u65f6\u4e0d\u663e\u793a\uff0c\u514d\u5f97\u538b\u5728\u62fc\u97f3\u4e0b\u9762')
  ok(ui.visibleSuggestion({ ...view, dismissed: '\u63d0\u4ea4\u5427' }) === null && ui.visibleSuggestion({ ...view, enabled: false }) === null, 'Esc \u5173\u6389\u6216\u8bbe\u7f6e\u5173\u95ed\u65f6\u4e0d\u663e\u793a')
  const key = (key, mods = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, nativeEvent: {}, preventDefault() {}, ...mods })
  ok(ui.suggestionKeyAction(key('Tab'), 'auto') === 'fill' && ui.suggestionKeyAction(key('ArrowRight'), 'auto') === 'fill', 'Tab \u548c \u2192 \u586b\u5165')
  ok(ui.suggestionKeyAction(key('Enter'), 'auto') === 'send', 'Enter \u76f4\u63a5\u53d1\u9001')
  ok(ui.suggestionKeyAction(key('Enter'), 'ctrlEnter') === null && ui.suggestionKeyAction(key('Enter', { ctrlKey: true }), 'ctrlEnter') === 'send', '\u53d1\u9001\u952e\u8bbe\u4e3a Ctrl+Enter \u65f6\u7167\u6b64\u529e\u7406')
  ok(ui.suggestionKeyAction(key('Escape'), 'auto') === 'dismiss', 'Esc \u5173\u6389\u5efa\u8bae')
  ok(ui.suggestionKeyAction(key('Tab', { shiftKey: true }), 'auto') === null && ui.suggestionKeyAction(key('Enter', { shiftKey: true }), 'auto') === null, 'Shift+Tab\u3001Shift+Enter \u4fdd\u6301\u539f\u6837')
  ok(ui.suggestionKeyAction(key('Tab', { nativeEvent: { isComposing: true } }), 'auto') === null, '\u8f93\u5165\u6cd5\u7ec4\u5b57\u65f6\u4e0d\u63a5\u7ba1\u6309\u952e')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`prompt-suggestion: ${checks} checks passed (offline, no model calls)`)
