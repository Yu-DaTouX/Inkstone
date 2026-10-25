import assert from 'node:assert/strict'

const finish = await import(new URL('../resources/pi-extensions/finish-reminder.js', import.meta.url))

for (const command of [
  'npm test', 'npm run test', 'npm run test:unit', 'pnpm test', 'yarn test', 'bun run test', 'npx mocha test/unit',
  'npx jest --runInBand', 'npx vitest run', 'pytest -q', 'python -m pytest tests', 'go test ./...', 'cargo test',
  'dotnet test', 'mvn -q test', './gradlew test', 'make test', 'node --test', 'cd lib && npm test'
]) assert.equal(finish.isTestCommand(command), true, `识别为测试命令：${command}`)
for (const command of ['ls', 'npm install', 'npm run build', 'cat test/foo.js', 'grep -rn test src', 'git status', 'npm run testing', '']) {
  assert.equal(finish.isTestCommand(command), false, `不是测试命令：${command}`)
}

const hooks = {}
finish.registerFinishReminder({ on: (name, fn) => { hooks[name] = fn } })
const payload = () => ({ messages: [{ role: 'user', content: '继续' }] })
const pass = (command = 'npm test', exit = 0) => hooks.tool_result({ toolName: 'bash', input: { command }, details: { exit_code: exit }, isError: exit !== 0 })
const step = (toolName = 'read') => {
  hooks.tool_call({ toolName })
  return hooks.before_provider_request({ payload: payload() })
}
const idleSteps = (count) => {
  const results = []
  for (let i = 0; i < count; i++) results.push(step())
  return results
}

hooks.message_end({ message: { role: 'user' } })
hooks.tool_call({ toolName: 'edit' })
pass()
assert.equal(hooks.before_provider_request({ payload: payload() }), undefined, '测试刚通过的下一次请求不提醒')
const first = idleSteps(4)
assert.deepEqual(first.slice(0, 3), [undefined, undefined, undefined], '未满 4 步不提醒')
assert.match(JSON.stringify(first[3]?.messages?.at(-1)), /tests passed after your last code change/, '连续 4 步没改代码后提醒收尾')
assert.equal(first[3].messages.at(-1).content.includes(finish.FINISH_REMINDER), true, '提醒追加在本次请求末尾')
const second = idleSteps(4)
assert.deepEqual(second.slice(0, 3), [undefined, undefined, undefined], '两次提醒之间至少隔 4 步')
assert.ok(second[3], '再过 4 步仍没改代码，第二次提醒')
assert.deepEqual(idleSteps(12), Array(12).fill(undefined), '每次用户请求最多提醒两次')

hooks.message_end({ message: { role: 'user' } })
pass()
step()
idleSteps(2)
assert.equal(step('edit'), undefined, '有新的 edit 就清掉测试通过状态')
assert.deepEqual(idleSteps(8), Array(8).fill(undefined), '改代码后未重新通过测试不提醒')
pass('npx vitest run')
step()
assert.ok(idleSteps(4)[3], '改代码后重新通过测试再计 4 步')

hooks.message_end({ message: { role: 'user' } })
hooks.tool_call({ toolName: 'write' })
pass('npm test', 1)
assert.deepEqual(idleSteps(8), Array(8).fill(undefined), '测试失败不提醒')
pass('npm run build')
assert.deepEqual(idleSteps(8), Array(8).fill(undefined), '非测试命令不算测试通过')
pass()
pass('npm test', 2)
assert.deepEqual(idleSteps(8), Array(8).fill(undefined), '之后又失败的测试清掉通过状态')
hooks.tool_result({ toolName: 'bash', input: { command: 'pytest' }, details: undefined, isError: false })
step()
assert.ok(idleSteps(4)[3], '没有 exit_code 时按 isError 判断')

hooks.message_end({ message: { role: 'user' } })
hooks.tool_result({ toolName: 'powershell', input: { command: 'dotnet test' }, details: { exit_code: 0 }, isError: false })
step()
const responses = (() => {
  for (let i = 0; i < 3; i++) step()
  hooks.tool_call({ toolName: 'read' })
  return hooks.before_provider_request({ payload: { input: [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }] } })
})()
assert.match(JSON.stringify(responses?.input?.at(-1)), /give the final answer now/, 'PowerShell 测试与 Responses 接口同样生效')

hooks.message_end({ message: { role: 'user' } })
assert.deepEqual(idleSteps(8), Array(8).fill(undefined), '新的用户请求清空状态')

console.log('finish reminder tests passed')
