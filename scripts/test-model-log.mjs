import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const log = await compile('src/main/main-log.ts')
  const fields = log.modelErrorLogFields('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
  ok(fields.cause === 'overload' && fields.status === 529, '模型错误只记归类与状态码', JSON.stringify(fields))
  const refresh = log.modelErrorLogFields('OAuth refresh failed for anthropic: invalid_grant')
  ok(refresh.cause === 'authExpired' && refresh.status === undefined, 'OAuth 刷新失败记成登录失效', JSON.stringify(refresh))
  const line = log.modelLogLine('key-failover', { provider: 'openai', from: 'sk-live-abcdef1234567890', to: '备用 Key', session: 'S1', switched: true, skipped: undefined, attempt: 2 })
  ok(!/abcdef1234567890/.test(line) && line.includes('to=备用_Key') && line.includes('switched=yes') && line.includes('attempt=2') && !line.includes('skipped'), '值里的密钥被遮掉、空格转下划线、空值不写', line)
  ok(/^error /.test(log.modelLogLine('error', { cause: 'x' })), '事件名在行首')
  log.logModelEvent('retry-end', { success: true, provider: 'anthropic', model: 'claude-x', session: 'S9' })
  const dir = join(process.env.YAN_DATA_DIR, 'logs')
  const file = readdirSync(dir).find((name) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(name))
  const text = file ? readFileSync(join(dir, file), 'utf8') : ''
  ok(/\[主进程\/模型\] retry-end success=yes provider=anthropic model=claude-x session=S9\n$/.test(text), '写进 yan/logs 的主进程日志，沿用原格式', text)
}, { isolate: true })
