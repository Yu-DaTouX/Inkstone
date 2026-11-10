import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const dangerGuard = (await import('../resources/pi-extensions/danger-guard.js')).default

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const answers = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let command = ''
    try { command = JSON.parse(body)?.command ?? '' } catch { }
    const summary = command === 'danger.prefs'
      ? { kind: 'danger-prefs', mode: 'danger', outsideWrites: true, allowRoots: [] }
      : { kind: 'danger-confirm', ...(answers.length ? answers.shift() : { allowed: true }) }
    const text = JSON.stringify({ ok: true, summary })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const saved = {}
for (const key of ['YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID', 'YAN_DANGER_GUARD']) saved[key] = process.env[key]
process.env.YAN_CLI_URL = `http://127.0.0.1:${port}/rpc`
process.env.YAN_CLI_TOKEN = 'test-token'
process.env.YAN_SESSION_ID = 'session-test'
process.env.YAN_PROJECT_ID = 'project-test'
delete process.env.YAN_DANGER_GUARD

const work = await mkdtemp(join(tmpdir(), 'yan-danger-refusal-'))
const cwd = join(work, 'project')
const outsideFile = join(dirname(tmpdir()), 'yan-danger-outside-probe', 'notes.txt')

try {
  const handlers = {}
  dangerGuard({ on: (name, fn) => { handlers[name] = fn } })
  const run = (input) => handlers.tool_call({ toolName: 'write', input, toolCallId: 'call-1' }, { cwd })

  answers.push({ allowed: false, decision: 'deny', feedback: '这些文件不能删' })
  const denied = await run({ path: outsideFile, content: 'x' })
  ok(denied?.block === true, '拒绝后仍然拦下操作', JSON.stringify(denied))
  ok(/Honour the refusal/.test(denied.reason ?? ''), '拒绝后的外层提示要求服从拒绝', denied.reason)
  ok(/do not retry this operation and do not reach the same result through another tool or route/i.test(denied.reason ?? ''), '拒绝后明确不能换工具或换做法绕过', denied.reason)
  ok(!/Try a safer approach|Adjust your approach accordingly and try again/i.test(denied.reason ?? ''), '拒绝后不再鼓励换做法继续', denied.reason)

  answers.push({ allowed: false, decision: 'deny' })
  const silentDeny = await run({ path: outsideFile, content: 'x' })
  ok(/Do not retry it and do not work around the refusal by another route/i.test(silentDeny?.reason ?? ''), '无理由拒绝时也不能绕过', silentDeny?.reason)
  ok(!/Try a safer approach/i.test(silentDeny?.reason ?? ''), '无理由拒绝时也不鼓励换做法', silentDeny?.reason)

  answers.push({ allowed: true })
  const allowed = await run({ path: outsideFile, content: 'x' })
  ok(allowed === undefined, '用户同意时照旧放行（审批条件未改）', JSON.stringify(allowed))
} finally {
  server.close()
  await rm(work, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

console.log(`danger-guard-refusal: ${checks} checks passed`)
