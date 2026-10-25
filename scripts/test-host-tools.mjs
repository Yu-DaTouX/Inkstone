import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hostTools = await import(new URL('../resources/pi-extensions/host-tool-call.js', import.meta.url))
const question = await import(new URL('../resources/pi-extensions/question.js', import.meta.url))
const guide = await import(new URL('../resources/pi-extensions/capability-guide.js', import.meta.url))

const env = { YAN_RUNNER_ID: 'primary', YAN_CLI_URL: 'http://127.0.0.1:1/', YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's1', YAN_PROJECT_ID: 'p1' }
assert.equal(hostTools.hostToolsAvailable(env), true)
assert.equal(hostTools.hostToolsAvailable({ ...env, YAN_RUNNER_ID: '' }), false, '子代理没有 YAN_RUNNER_ID，不注册宿主工具')
assert.equal(hostTools.hostToolsAvailable({}), false)

const dir = await mkdtemp(join(tmpdir(), 'inkstone-host-tools-'))
try {
  const resultFile = join(dir, 'result.json')
  await writeFile(resultFile, JSON.stringify({ question: 'Q?', options: ['A', 'B'], answer: 'A', cancelled: false }))
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) })
    return { json: async () => ({ ok: true, summary: { kind: 'question' }, resultFile }) }
  }
  const ok = await hostTools.callHostTool({ command: 'question.ask', params: { question: 'Q?' }, toolCallId: 'call-1', cwd: 'C:/p', env, fetchImpl })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.answer, 'A')
  assert.equal(seen[0].url, env.YAN_CLI_URL)
  assert.equal(seen[0].init.headers.authorization, 'Bearer t')
  assert.deepEqual(seen[0].body.params.toolCall, { id: 'call-1', cwd: 'C:/p', subagent: false })
  assert.equal(seen[0].body.sessionId, 's1')
  assert.equal(seen[0].body.projectId, 'p1')

  const controller = new AbortController()
  controller.abort()
  const aborted = await hostTools.callHostTool({ command: 'question.ask', params: {}, toolCallId: 'c', signal: controller.signal, env,
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error } })
  assert.deepEqual([aborted.ok, aborted.cancelled], [false, true])
  const refused = await hostTools.callHostTool({ command: 'tasks.apply', params: {}, toolCallId: 'c', env,
    fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'bad', code: 'task_bad' }) }) })
  assert.deepEqual([refused.ok, refused.error, refused.code], [false, 'bad', 'task_bad'])
  assert.equal((await hostTools.callHostTool({ command: 'x', params: {}, toolCallId: 'c', env: {} })).ok, false)

  const answered = question.questionResult({ ok: true, data: { question: 'Q?', options: ['A'], answer: 'A', cancelled: false } })
  assert.match(answered.content[0].text, /^Answer: A/)
  assert.equal(answered.details.answer, 'A')
  assert.equal(answered.isError, undefined)
  const dismissed = question.questionResult({ ok: true, data: { question: 'Q?', answer: null, cancelled: true } })
  assert.match(dismissed.content[0].text, /Do not guess/)
  const form = question.questionResult({ ok: true, data: { question: 'Q?', fields: [{ name: 'a' }], answers: { a: 1 }, answer: 'a: 1', cancelled: false } })
  assert.match(form.content[0].text, /"a":1/)
  assert.equal(question.questionResult({ ok: false, error: 'timeout' }).isError, true)
  assert.equal(question.questionResult({ ok: false, cancelled: true, error: 'cancelled' }).isError, undefined)

  const calls = []
  const tool = question.createQuestionTool(async (input) => { calls.push(input); return { ok: true, data: { question: 'Q?', answer: 'B', cancelled: false } } })
  const signal = new AbortController().signal
  const result = await tool.execute('tc-9', { question: 'Q?', options: ['A', 'B'] }, signal, undefined, { cwd: 'C:/w' })
  assert.equal(calls[0].command, 'question.ask')
  assert.equal(calls[0].toolCallId, 'tc-9')
  assert.equal(calls[0].cwd, 'C:/w')
  assert.equal(calls[0].signal, signal)
  assert.match(result.content[0].text, /Answer: B/)

  const todoCalls = []
  const todos = guide.createTodosTool(async (input) => {
    todoCalls.push(input)
    return { ok: true, data: { action: 'set', revision: 2, todos: [{ text: 'read', done: true }, { text: 'write', done: false }] } }
  })
  const todoResult = await todos.execute('tc-1', { action: 'set', items: [{ text: 'read' }, { text: 'write' }] }, signal, undefined, { cwd: 'C:/w' })
  assert.equal(todoCalls[0].command, 'tasks.apply')
  assert.equal(todoCalls[0].params.operationId, 'tc-1', '工具调用 id 作为幂等 operationId')
  assert.deepEqual(todoCalls[0].params.items, [{ text: 'read' }, { text: 'write' }])
  assert.equal('index' in todoCalls[0].params, false)
  assert.match(todoResult.content[0].text, /1\/2 done/)
  assert.match(todoResult.content[0].text, /\[x\] 1\. read/)
  assert.equal(todoResult.details.revision, 2)
  const todoFail = guide.todosResult({ ok: false, error: 'index out of range', data: { todos: [{ text: 'x', done: false }] } })
  assert.match(todos.description, /action: "set" replaces the whole list with items; "add" appends items; "complete"\/"uncomplete"\/"remove" take a 1-based index; "clear" empties it\..*At most 8 items.*32 characters/)
  assert.equal(todoFail.isError, true)
  assert.match(todoFail.content[0].text, /\[ \] 1\. x/)

  assert.equal(guide.touchesTasks('todos', {}), true)
  assert.equal(guide.touchesTasks('bash', { command: 'yan tasks apply' }), true)
  assert.equal(guide.touchesTasks('bash', { command: 'ls' }), false)
  assert.equal(guide.CAPABILITY_GUIDE, guide.capabilityGuide(false))
  const withTools = guide.capabilityGuide(true)
  assert.match(withTools, /the `todos` tool/)
  assert.doesNotMatch(withTools, /yan tasks apply|- question: |- tasks: /)
  assert.match(guide.CAPABILITY_GUIDE, /yan tasks apply/)
  assert.match(guide.taskReminder(true), /`todos` tool/)
  assert.equal(guide.TASK_REMINDER, guide.taskReminder(false))
  assert.match(guide.environmentGuide(new Date(2026, 9, 26), 'win32', undefined), /Git Bash.*edit\/write tools; Python text-mode writes on Windows turn \\n into \\r\\n\./)
  assert.match(question.TOOL_GUIDANCE, /`question` tool/)
  assert.match(question.CLI_GUIDANCE, /yan question ask/)

  const registered = []
  const hooks = {}
  const pi = { registerTool: (definition) => registered.push(definition), on: (name, fn) => { hooks[name] = fn } }
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    question.default(pi)
    guide.default(pi)
  } finally {
    for (const key of Object.keys(env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
  assert.deepEqual(registered.map((definition) => definition.name), ['question', 'todos'])
  for (const definition of registered) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
  }

  const payloadFor = (text = '继续') => ({ messages: [{ role: 'user', content: text }] })
  hooks.tool_call({ toolName: 'todos', input: { action: 'set', items: [{ text: 'a' }] } })
  for (let i = 0; i < guide.TASK_REMINDER_AFTER; i++) hooks.tool_call({ toolName: 'bash', input: { command: 'ls' } })
  assert.equal(hooks.before_provider_request({ payload: payloadFor() }), undefined, '写过计划后长回合不再提醒写计划')
  hooks.message_end({ message: { role: 'user' } })
  for (let i = 0; i < guide.TASK_REMINDER_AFTER; i++) hooks.tool_call({ toolName: 'bash', input: { command: 'ls' } })
  const reminded = hooks.before_provider_request({ payload: payloadFor() })
  assert.ok(reminded, '用户提出新要求后计划标记归零，长回合又会提醒写计划')
  assert.match(JSON.stringify(reminded.messages.at(-1)), /many tool calls without a to-do list/)

  const sizes = registered.map((definition) => JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length)
  const removed = guide.CAPABILITY_GUIDE.length - withTools.length + (question.CLI_GUIDANCE.length - question.TOOL_GUIDANCE.length)
  console.log(`host tools ok (tool definitions ${sizes.join(' + ')} chars ≈ ${Math.round(sizes.reduce((a, b) => a + b, 0) / 4)} tokens; guide text change ${-removed} chars)`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
