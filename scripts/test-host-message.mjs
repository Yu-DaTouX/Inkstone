import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { hostMessageKind, isHostAutomatedMessage, isHostContinuation } = await import('../resources/pi-extensions/host-message.js')
const { createTurnModelSwitch } = await import('../resources/pi-extensions/turn-model-switch.js')
const { requestSlice } = await import('../resources/pi-extensions/ultracode.js')
const { visibleTurns } = await import('../resources/pi-extensions/prompt-suggestion.js')
const { subagentCapabilityGuide, default: subagentGuideExtension } = await import('../resources/pi-extensions/subagent-guide.js')
const { environmentGuide } = await import('../resources/pi-extensions/capability-guide.js')
const { runnerPrompt, SUBAGENT_WORK_GUIDANCE, SUBAGENT_READ_ONLY_WORK_GUIDANCE } = await import('../resources/pi-extensions/preamble.js')

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const HOST_MESSAGES = [
  ['<subagent-notification id="sub-1" status="done">\n完成\n</subagent-notification>', 'subagent-notice'],
  ['[循环恢复 · 自动继续 1/1]\n上一轮因输出重复被安全中止。', 'continuation'],
  ['[模型错误恢复 · 自动继续 1/1]\n上一轮模型请求中断。', 'continuation'],
  ['[额度换号 · 自动继续 1/1]\n上一轮因订阅账号额度用完中断。', 'continuation'],
  ['[Auto-continue 1/1] The previous model request failed with a temporary error.', 'continuation'],
  ['额度已恢复，请从上一轮中断的地方继续完成任务。', 'quota-resume'],
  ['[砚宿主通知：后台终端命令]\n终端：bash', 'host-notice']
]

for (const [text, kind] of HOST_MESSAGES) {
  ok(hostMessageKind(text) === kind && isHostAutomatedMessage(text), `识别宿主消息：${kind}`, hostMessageKind(text))
}
ok(hostMessageKind('请帮我看看这个函数') === null, '普通用户消息不是宿主消息')
ok(!isHostAutomatedMessage('请解释 <subagent-notification> 这个标签的含义'), '正文里提到标签但开头不是通知时不误判')
ok(isHostContinuation('[额度换号 · 自动继续 1/1]\n…') && !isHostContinuation('[砚宿主通知：会话已移动]'), '区分续跑句与宿主通知')

{
  const root = await mkdtemp(join(tmpdir(), 'yan-host-message-'))
  try {
    await mkdir(join(root, 'pending-model-switch'), { recursive: true })
    const target = join(root, 'pending-model-switch', 's1.json')
    const applied = []
    const pi = { setModel: async (model) => { applied.push(`model:${model.id}`) }, setThinkingLevel: (level) => applied.push(`thinking:${level}`) }
    const ext = createTurnModelSwitch(pi, root)
    const ctx = { sessionManager: { getSessionId: () => 's1' }, modelRegistry: { find: (provider, id) => ({ provider, id }) } }
    const message = (text) => ({ message: { role: 'user', content: [{ type: 'text', text }] } })
    for (const [text] of HOST_MESSAGES) {
      await writeFile(target, JSON.stringify({ provider: 'fixture', id: 'b', thinkingLevel: 'high' }))
      await ext.onMessageStart(message(text), ctx)
      ok(applied.length === 0, `宿主消息不触发待切换模型（${hostMessageKind(text)}）`, JSON.stringify(applied))
    }
    await writeFile(target, JSON.stringify({ provider: 'fixture', id: 'b', thinkingLevel: 'high' }))
    await ext.onMessageStart(message('继续'), ctx)
    ok(applied.join(',') === 'model:b,thinking:high', '真实用户消息开始时应用待切换模型', JSON.stringify(applied))
    applied.length = 0
    await writeFile(target, JSON.stringify({ thinkingLevel: 'low' }))
    await ext.onAgentSettled({}, { ...ctx, hasPendingMessages: () => false })
    ok(applied.join(',') === 'thinking:low', '彻底空闲时应用待切换模型', JSON.stringify(applied))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

{
  const branch = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '第一轮真实问题' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '[额度换号 · 自动继续 1/1]\n上一轮因订阅账号额度用完中断。' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '继续' }] } }
  ]
  const slice = requestSlice(branch)
  ok(slice.prompt === '第一轮真实问题', 'ultracode 把续跑句排除在用户回合之外', slice.prompt)
  const turns = visibleTurns(branch)
  ok(turns.length === 1 && turns[0].includes('第一轮真实问题'), '提示建议只按真实用户回合建模', JSON.stringify(turns))
}

{
  const commands = ['danger.confirm', 'danger.prefs', 'search.query', 'search.fetch', 'search.docs', 'artifact.preview']
  const readOnly = subagentCapabilityGuide(commands, { readOnly: true })
  ok(/read-only/i.test(readOnly) && !/Git Bash|\bbash\b/.test(readOnly), '只读子代理指南不教 bash / Git Bash', readOnly)
  ok(/read tools in your tool list/.test(readOnly) && !/git_inspect|grep, find/.test(readOnly), '只读指南指向工具列表，不重复列工具名', readOnly)
  ok(!/\byan\b/.test(readOnly), '只读子代理没有 shell，指南不列用不了的 yan 命令', readOnly)
  ok(/main agent should run it/.test(readOnly) && readOnly.match(/no shell/g)?.length === 1, '只读指南要求把需要的命令写进报告，没有 shell 只说一次', readOnly)
  const normal = subagentCapabilityGuide(commands, { readOnly: false })
  ok(/The `yan` CLI is on PATH/.test(normal) && !/read-only/i.test(normal), '普通子代理指南不变', normal)

  const readOnlyEnv = environmentGuide(new Date(2026, 10, 10), 'win32', undefined, true, { readOnly: true })
  ok(readOnlyEnv === 'Today: 2026-11-10 (local date).', '只读环境说明是一行字符串，只给日期，不提 shell 与 Git Bash', readOnlyEnv)
  ok(/Git Bash/.test(environmentGuide(new Date(2026, 10, 10), 'win32', undefined, true)), '普通子代理环境说明不变')

  const readOnlyPrompt = runnerPrompt({ YAN_RUNNER_KIND: 'subagent', YAN_READ_ONLY_SUBAGENT: '1' })
  ok(readOnlyPrompt.work === SUBAGENT_READ_ONLY_WORK_GUIDANCE && !/shell/.test(readOnlyPrompt.work), '只读子代理工作说明不提 shell（只在能力段说一次）', readOnlyPrompt.work)
  ok(readOnlyPrompt.work !== SUBAGENT_WORK_GUIDANCE, '只读与可写子代理的工作说明分开')
  const normalPrompt = runnerPrompt({ YAN_RUNNER_KIND: 'subagent' })
  ok(/shell commands that may take long/.test(normalPrompt.work), '普通子代理工作说明不变', normalPrompt.work)
}

{
  const saved = process.env.YAN_READ_ONLY_SUBAGENT
  process.env.YAN_SUBAGENT_COMMANDS = 'danger.confirm,search.query'
  process.env.YAN_READ_ONLY_SUBAGENT = '1'
  try {
    const handlers = {}
    subagentGuideExtension({ on: (name, fn) => { handlers[name] = fn } })
    const sections = {}
    handlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: { sections } })
    ok(/read-only/i.test(sections.inkstone_capabilities) && /^Today: \d{4}-\d{2}-\d{2} \(local date\)\.$/.test(sections.inkstone_environment), '只读子代理的段落注入只读指南与环境', sections.inkstone_environment)
    ok(!/Git Bash/.test(`${sections.inkstone_capabilities}${sections.inkstone_environment}`), '只读子代理的段落里没有 Git Bash 指引')
  } finally {
    if (saved === undefined) delete process.env.YAN_READ_ONLY_SUBAGENT
    else process.env.YAN_READ_ONLY_SUBAGENT = saved
    delete process.env.YAN_SUBAGENT_COMMANDS
  }
}

console.log(`host-message: ${checks} checks passed`)
