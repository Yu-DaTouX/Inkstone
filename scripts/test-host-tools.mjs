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
  assert.match(dismissed.content[0].text, /stop and wait for the user/)
  const empty = question.questionResult({ ok: true, data: { question: 'Q?', answer: null, cancelled: false } })
  assert.equal(empty.content[0].text, 'The user did not answer the question.')
  const form = question.questionResult({ ok: true, data: { question: 'Q?', fields: [{ name: 'a' }], answers: { a: 1 }, answer: 'a: 1', cancelled: false } })
  assert.match(form.content[0].text, /"a":1/)
  assert.equal(question.questionResult({ ok: false, error: 'timeout' }).isError, true)
  const timedOut = question.questionResult({ ok: false, error: '问题等待超时，未猜测用户答案', code: 'question_timeout' })
  assert.equal(timedOut.isError, undefined)
  assert.match(timedOut.content[0].text, /best judgment/)
  assert.match(timedOut.content[0].text, /state the assumption/)
  assert.doesNotMatch(timedOut.content[0].text, /Do not guess/)
  assert.equal(timedOut.details.timedOut, true)
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
  await todos.execute('tc-2', { items: [{ text: 'only items' }] }, signal, undefined, { cwd: 'C:/w' })
  assert.equal(todoCalls[1].params.action, 'set', '缺 action 但带 items 时按 set 处理')
  assert.equal(todos.parameters.required, undefined, 'action 不再必填')
  await todos.execute('tc-3', { index: 1 }, signal, undefined, { cwd: 'C:/w' })
  assert.equal(todoCalls[2].params.action, undefined, '既无 action 也无 items 时不猜，交给宿主报错')
  const todoFail = guide.todosResult({ ok: false, error: 'index out of range', data: { todos: [{ text: 'x', done: false }] } })
  assert.match(todos.description, /action: "set" \(the default when only items are given\) replaces the whole list with items; "add" appends items; "complete"\/"uncomplete"\/"remove" take a 1-based index; "clear" empties it\..*At most 20 items.*80 characters/)
  assert.equal(todos.parameters.properties.items.maxItems, 20)
  assert.equal(todos.parameters.properties.items.items.properties.text.maxLength, 80)
  assert.equal(todoFail.isError, true)
  assert.match(todoFail.content[0].text, /\[ \] 1\. x/)

  assert.equal(guide.CAPABILITY_GUIDE, guide.capabilityGuide(false))
  const withTools = guide.capabilityGuide(true)
  assert.match(withTools, /the `todos` tool/)
  assert.doesNotMatch(withTools, /yan tasks apply|- question: |- tasks: /)
  assert.match(guide.CAPABILITY_GUIDE, /yan tasks apply/)
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

  // 催办和收尾提醒都已去掉：提问与能力指引不再往请求里追加任何提醒
  assert.equal(hooks.before_provider_request, undefined, '提问与能力指引不注册 before_provider_request')
  assert.equal(hooks.message_end, undefined, '提问与能力指引不跟踪回合')

  const { appendReminder } = await import(new URL('../resources/pi-extensions/request-reminder.js', import.meta.url))
  const userItem = { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
  const toolOutput = { type: 'function_call_output', call_id: 'c1', output: 'ok' }
  const onUser = appendReminder({ model: 'm', input: [userItem], stream: true }, 'R')
  assert.deepEqual(onUser, { model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: '继续' }, { type: 'input_text', text: 'R' }] }], stream: true }, 'Responses：末项是用户消息时追加 input_text')
  assert.equal(userItem.content.length, 1, 'Responses：不改原 payload')
  assert.deepEqual(appendReminder({ input: [userItem, toolOutput] }, 'R').input, [userItem, toolOutput, { role: 'user', content: [{ type: 'input_text', text: 'R' }] }], 'Responses：末项是工具结果时追加一条用户消息')
  assert.deepEqual(appendReminder({ input: [{ type: 'message', role: 'user', content: 'hi' }] }, 'R').input.at(-1).content, [{ type: 'input_text', text: 'hi' }, { type: 'input_text', text: 'R' }])
  assert.equal(appendReminder({ input: [] }, 'R'), undefined)
  assert.equal(appendReminder({}, 'R'), undefined)

  const sizes = registered.map((definition) => JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length)
  const removed = guide.CAPABILITY_GUIDE.length - withTools.length + (question.CLI_GUIDANCE.length - question.TOOL_GUIDANCE.length)
  console.log(`host tools ok (tool definitions ${sizes.join(' + ')} chars ≈ ${Math.round(sizes.reduce((a, b) => a + b, 0) / 4)} tokens; guide text change ${-removed} chars)`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
