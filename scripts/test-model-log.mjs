import './lib/test-isolate.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const log = await compile('src/main/main-log.ts')
  const fields = log.modelErrorLogFields('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
  ok(fields.cause === 'overload' && fields.status === 529, '模型错误只记归类与状态码', JSON.stringify(fields))
  const refresh = log.modelErrorLogFields('OAuth refresh failed for anthropic: invalid_grant')
  ok(refresh.cause === 'authExpired' && refresh.status === undefined, 'OAuth 刷新失败记成登录失效', JSON.stringify(refresh))
  const body = log.modelErrorLogFields('request failed: context has 450 tokens and 503 items, 404 lines')
  ok(body.status === undefined, '正文里的 450、503 之类数字不当成状态码', JSON.stringify(body))
  ok(log.modelErrorLogFields('OAuth refresh failed for anthropic: refresh returned 500 tokens').status === undefined, '刷新失败原因里的数字不当成状态码')
  ok(log.modelErrorLogFields({ status: 503, message: 'Service Unavailable' }).status === 503, '结构化的 status 字段取状态码')
  ok(log.modelErrorLogFields({ error: { statusCode: '429', message: 'slow down' } }).status === 429, '嵌套的 statusCode 字段取状态码')
  ok(log.modelErrorLogFields('{"status":502,"error":"bad gateway"}').status === 502, 'JSON 文本里的 status 字段取状态码')
  ok(log.modelErrorLogFields('HTTP 500 internal').status === 500 && log.modelErrorLogFields('404 model_not_found').status === 404, '开头的状态码取状态码')
  ok(log.modelErrorLogFields({ status: 200, message: 'ok 450' }).status === undefined && log.modelErrorLogFields({ code: 'ECONNRESET' }).status === undefined, '非错误状态码与非数字 code 不取')
  const hashed = log.accountLogId('yan:openai-codex:someone@example.com')
  ok(/^[0-9a-f]{8}$/.test(hashed) && !hashed.includes('example') && hashed === log.accountLogId('yan:openai-codex:someone@example.com') && hashed !== log.accountLogId('yan:openai-codex:other@example.com') && log.accountLogId(undefined) === undefined, '账号只记 key 的 8 位短哈希，同一账号稳定、不同账号不同、没有 key 不记', hashed)
  ok(!log.modelLogLine('account-switch', { to: hashed }).includes('@'), '日志行里没有邮箱')
  const line = log.modelLogLine('key-failover', { provider: 'openai', from: 'sk-live-abcdef1234567890', to: '备用 Key', session: 'S1', switched: true, skipped: undefined, attempt: 2 })
  ok(!/abcdef1234567890/.test(line) && line.includes('to=备用_Key') && line.includes('switched=yes') && line.includes('attempt=2') && !line.includes('skipped'), '值里的密钥被遮掉、空格转下划线、空值不写', line)
  ok(/^error /.test(log.modelLogLine('error', { cause: 'x' })), '事件名在行首')
  log.logModelEvent('retry-end', { success: true, provider: 'anthropic', model: 'claude-x', session: 'S9' })
  const dir = join(process.env.YAN_DATA_DIR, 'logs')
  const file = readdirSync(dir).find((name) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(name))
  const text = file ? readFileSync(join(dir, file), 'utf8') : ''
  ok(/\[主进程\/模型\] retry-end success=yes provider=anthropic model=claude-x session=S9\n$/.test(text), '写进 yan/logs 的主进程日志，沿用原格式', text)
}, { isolate: true })
