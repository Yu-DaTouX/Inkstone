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
  const missingFile = await hostTools.callHostTool({ command: 'tasks.apply', params: {}, toolCallId: 'c', env,
    fetchImpl: async () => ({ json: async () => ({ ok: true, summary: { kind: 'tasks' }, resultFile: join(dir, 'gone.json') }) }) })
  assert.deepEqual([missingFile.ok, missingFile.code], [false, 'result_unreadable'], '结果文件读不到时不伪装成成功')
  assert.match(guide.todosResult(missingFile).content[0].text, /could not be read/)
  const noFileExpected = await hostTools.callHostTool({ command: 'x', params: {}, toolCallId: 'c', env, fetchImpl: async () => ({ json: async () => ({ ok: true, summary: {} }) }) })
  assert.equal(noFileExpected.ok, true, '宿主本来就没有结果文件的命令仍算成功')

  const answered = question.questionResult({ ok: true, data: { question: 'Q?', options: ['A'], answer: 'A', cancelled: false } })
  assert.match(answered.content[0].text, /^Answer: A/)
  assert.equal(answered.details.answer, 'A')
  assert.equal(answered.isError, undefined)
  const dismissed = question.questionResult({ ok: true, data: { question: 'Q?', answer: null, cancelled: true } })
  assert.match(dismissed.content[0].text, /Do not guess/)
  assert.match(dismissed.content[0].text, /stop and wait for the user/)
  const empty = question.questionResult({ ok: true, data: { question: 'Q?', answer: null, cancelled: false } })
  assert.match(empty.content[0].text, /empty answer/)
  assert.match(empty.content[0].text, /stop and wait for the user/, '空答案和主动关掉一样停下等用户')
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

  assert.equal(question.asksForSecret('请提供数据库密码'), true)
  assert.equal(question.asksForSecret('What is your API key?'), true)
  assert.equal(question.asksForSecret('密码策略放在哪个文件？'), false, '只提到密码、没有索要时不切密文')
  assert.equal(question.asksForSecret('要继续吗？'), false)
  const detected = question.protectSecretRequest({ question: '请输入 GitHub token 和密码' })
  assert.equal(detected.fields[0].kind, 'secret')
  assert.equal(detected.fields[0].detected, true)
  assert.equal(question.protectSecretRequest({ question: '请提供密码', options: ['A', 'B'] }).fields, undefined, '有选项的问题不改')
  const secretForm = question.protectSecretRequest({ question: 'Q', fields: [{ name: 'pw', label: '数据库密码', kind: 'text' }, { name: 'host', label: '主机', kind: 'text' }] })
  assert.deepEqual(secretForm.fields.map((f) => f.kind), ['secret', 'text'], '表单里只转标签是秘密的文本字段')

  const held = {}
  const store = question.createSecretStore(held)
  const secretValue = 'hunter2-value'
  const secretCalls = []
  const secretTool = question.createQuestionTool(async (input) => {
    secretCalls.push(input)
    return { ok: true, secrets: { YAN_SECRET_VALUE: secretValue, BAD_NAME: 'x' }, data: { question: 'Q', fields: [], answers: { value: '已提供' }, answer: 'Q：已提供', cancelled: false } }
  }, store)
  const secretResult = await secretTool.execute('tc-s', { question: '请提供密码' }, undefined, undefined, {})
  assert.equal(secretCalls[0].params.fields[0].kind, 'secret')
  assert.equal(held.YAN_SECRET_VALUE, secretValue)
  assert.equal(held.BAD_NAME, undefined, '只接受 YAN_SECRET_ 前缀，不能覆盖其他环境变量')
  assert.ok(!JSON.stringify(secretResult).includes(secretValue), '给模型的结果和 details 都没有原文')
  assert.match(secretResult.content[0].text, /\$YAN_SECRET_VALUE/)

  const masked = question.maskToolResult({ content: [
    { type: 'text', text: `a ${secretValue} b ${Buffer.from(secretValue).toString('base64')}` },
    { type: 'image', data: 'x' }
  ] }, store.values())
  assert.equal(masked.content[0].text, 'a [REDACTED] b [REDACTED]')
  assert.equal(masked.content[1].type, 'image')
  assert.equal(question.maskToolResult({ content: [{ type: 'text', text: 'clean' }] }, store.values()), undefined)
  assert.equal(question.maskSecrets('abc abc', ['abc']), 'abc abc', '太短的值不替换，免得误伤输出')
  store.clear()
  assert.equal(held.YAN_SECRET_VALUE, undefined)
  assert.deepEqual(store.values(), [])

  const handlers = {}
  const previous = process.env.YAN_SECRET_LEFT
  question.default({ on: (name, fn) => { handlers[name] = fn } })
  assert.equal(typeof handlers.tool_result, 'function')
  assert.equal(typeof handlers.session_start, 'function')
  assert.equal(previous, undefined)

  const { build } = await import('esbuild')
  const formOut = join(dir, 'question-form.mjs')
  await build({ entryPoints: ['src/shared/question-form.ts'], outfile: formOut, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const qf = await import(new URL(`file:///${formOut.replaceAll('\\', '/')}`).href)
  const fields = qf.parseQuestionFields([{ name: 'db-pw', label: '密码', kind: 'secret', detected: true }, { name: 'host', label: '主机', kind: 'text' }])
  assert.equal(fields[0].detected, true)
  const rawAnswer = JSON.stringify({ 'db-pw': ' sp ace\n', host: 'h1' })
  const parsedAnswers = qf.parseQuestionAnswers(fields, rawAnswer)
  assert.equal(parsedAnswers['db-pw'], ' sp ace', '密文不去空格，只去结尾换行')
  const split = qf.separateSecrets(fields, parsedAnswers, rawAnswer)
  assert.deepEqual(split.secrets, { YAN_SECRET_DB_PW: ' sp ace' })
  assert.notEqual(split.answers['db-pw'], ' sp ace')
  assert.equal(split.answers.host, 'h1')
  assert.ok(!qf.summarizeAnswers(fields, split.answers).includes('sp ace'))
  const plainRaw = JSON.stringify({ 'db-pw': 'not secret', [qf.QUESTION_PLAIN_KEY]: ['db-pw'] })
  const plainSplit = qf.separateSecrets(fields, qf.parseQuestionAnswers(fields, plainRaw), plainRaw)
  assert.deepEqual(plainSplit.secrets, {}, '用户选了按普通文本回答')
  assert.equal(plainSplit.answers['db-pw'], 'not secret')
  const declared = qf.parseQuestionFields([{ name: 'pw', label: '密码', kind: 'secret' }])
  const forgedRaw = JSON.stringify({ pw: 'v', [qf.QUESTION_PLAIN_KEY]: ['pw'] })
  assert.deepEqual(qf.separateSecrets(declared, qf.parseQuestionAnswers(declared, forgedRaw), forgedRaw).secrets, { YAN_SECRET_PW: 'v' }, '模型声明的密文字段不能转普通文本')

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
  await todos.execute('tc-4', { action: 'set', items: [{ text: 'run', status: 'running' }, { text: 'wait', status: 'blocked' }] }, signal, undefined, { cwd: 'C:/w' })
  assert.deepEqual(todoCalls[3].params.items, [{ text: 'run', status: 'running' }, { text: 'wait', status: 'blocked' }], 'items.status 原样传给宿主校验')
  assert.deepEqual(todos.parameters.properties.items.items.properties.status.enum, ['pending', 'running', 'done', 'blocked'], 'items.status 只接受四个规范值')
  const statusResult = guide.todosResult({ ok: true, data: { action: 'set', revision: 3, todos: [{ text: 'run', done: false, status: 'running' }, { text: 'wait', done: false, status: 'blocked' }, { text: 'ok', done: true }] } })
  assert.match(statusResult.content[0].text, /1\/3 done/)
  assert.match(statusResult.content[0].text, /\[>\] 1\. run \(in progress\)/, '回执把 running 明确写出来')
  assert.match(statusResult.content[0].text, /\[!\] 2\. wait \(blocked\)/, '回执区分 blocked')
  assert.match(statusResult.content[0].text, /\[x\] 3\. ok/)
  const statusFail = guide.todosResult({ ok: false, error: 'index out of range', data: { todos: [{ text: 'run', done: false, status: 'running' }] } })
  assert.match(statusFail.content[0].text, /\[>\] 1\. run \(in progress\)/, '失败回执也保留 running')
  const todoFail = guide.todosResult({ ok: false, error: 'index out of range', data: { todos: [{ text: 'x', done: false }] } })
  assert.match(todos.description, /action "set" \(the default when items are given\) replaces the list; "add" appends; "complete"\/"uncomplete"\/"remove" take a 1-based index; "clear" empties it\..*Each text is a short title\.$/)
  assert.doesNotMatch(todos.description, /At most 20|80 characters/, '数量与长度上限只写在 schema 里，不在描述里重复')
  assert.equal(todos.parameters.properties.items.maxItems, 20)
  assert.equal(todos.parameters.properties.items.items.properties.text.maxLength, 80)
  assert.equal(todoFail.isError, true)
  assert.match(todoFail.content[0].text, /\[ \] 1\. x/)

  assert.equal(guide.CAPABILITY_GUIDE, guide.capabilityGuide(false))
  const withTools = guide.capabilityGuide(true)
  assert.match(withTools, /the `todos` tool/)
  assert.doesNotMatch(withTools, /yan tasks apply|- question: |- tasks: |web search, page text/, '已有对应工具的命令组不在清单里重复')
  assert.match(withTools, /^- search: library docs \(`yan search docs --library <name> --query-text "\.\.\."`\)$/m, '文档查询只走命令行，清单里留一行指路')
  assert.match(guide.CAPABILITY_GUIDE, /yan tasks apply/)
  assert.match(guide.CAPABILITY_GUIDE, /- search: web search, page text, library docs/, '没有联网工具时清单保留 search 组')
  assert.doesNotMatch(guide.CAPABILITY_GUIDE, /SKILL\.md once|sleep-poll|skill artifact\)|skill capabilities covers/, '技能清单已说明的内容不在能力清单里重复')
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
  assert.deepEqual(registered.map((definition) => definition.name), ['question', 'todos', 'web_search', 'web_fetch'], '主会话不注册 web_docs，文档查询走 yan search docs')
  for (const definition of registered) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
  }

  // 催办和收尾提醒都已去掉：提问与能力指引不再往请求里追加任何提醒
  assert.equal(hooks.before_provider_request, undefined, '提问与能力指引不注册 before_provider_request')
  assert.equal(hooks.message_end, undefined, '提问与能力指引不跟踪回合')


  const sizes = registered.map((definition) => JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length)
  const removed = guide.CAPABILITY_GUIDE.length - withTools.length + (question.CLI_GUIDANCE.length - question.TOOL_GUIDANCE.length)
  console.log(`host tools ok (tool definitions ${sizes.join(' + ')} chars ≈ ${Math.round(sizes.reduce((a, b) => a + b, 0) / 4)} tokens; guide text change ${-removed} chars)`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
