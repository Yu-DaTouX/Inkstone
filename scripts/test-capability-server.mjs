import './lib/test-isolate.mjs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { CapabilityServer, CAPABILITY_API_VERSION } = await compile('src/main/capability-server.ts')
  const opsDir = await mkdtemp(join(tmpdir(), 'yan-ops-'))

  const server = new CapabilityServer({ opsDir })
  const { url, token } = await server.start({ sessionId: 's-1', projectId: 'p-1' })

  const call = async (body, headers = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers
      },
      body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, ...body })
    })
    return { status: res.status, body: await res.json() }
  }
  const me = { sessionId: 's-1', projectId: 'p-1' }

  const good = await call({ ...me, command: 'operations.status', params: { limit: 5 } })
  ok(good.status === 200 && good.body.ok === true, '能力服务：合法请求返回 ok', JSON.stringify(good.body).slice(0, 140))
  ok(typeof good.body.resultFile === 'string', '能力服务：大结果落文件并回路径', String(good.body.resultFile))
  ok(!('data' in good.body), '能力服务：响应只回摘要，不回完整数据', Object.keys(good.body ?? {}).join(','))
  if (typeof good.body.resultFile === 'string') {
    const text = await readFile(good.body.resultFile, 'utf8')
    ok(text.includes('"ops"'), '能力服务：结果文件是结构化 JSON', text.slice(0, 60))
  }

  const forged = await call({ sessionId: 's-1', projectId: 'p-2', command: 'operations.status' })
  ok(
    forged.status === 403 && forged.body.error === 'identity_mismatch',
    '能力服务：伪造 projectId 被拒',
    JSON.stringify(forged.body)
  )
  const forgedSession = await call({ sessionId: 's-9', projectId: 'p-1', command: 'operations.status' })
  ok(forgedSession.status === 403, '能力服务：伪造 sessionId 同样被拒', JSON.stringify(forgedSession.body))

  const badToken = await call({ ...me, command: 'operations.status' }, { authorization: 'Bearer wrong' })
  ok(badToken.status === 401, '能力服务：错误 token 被拒', JSON.stringify(badToken.body))

  const unknown = await call({ ...me, command: 'evil.exfiltrate' })
  ok(
    unknown.status === 400 && unknown.body.error === 'unknown_command',
    '能力服务：未登记命令被拒',
    JSON.stringify(unknown.body)
  )

  const notImpl = await call({ ...me, command: 'skill.read' })
  ok(
    notImpl.status === 200 && notImpl.body.ok === false && /not_implemented/.test(String(notImpl.body.error)),
    '能力服务：未实现命令走完整管道后如实报错',
    JSON.stringify(notImpl.body)
  )

  const subagentRegistered = await call({ ...me, command: 'subagent.list' })
  ok(
    subagentRegistered.status === 200 && subagentRegistered.body.error !== 'unknown_command',
    '能力服务：子代理命令已登记进宿主入口',
    JSON.stringify(subagentRegistered.body)
  )

  const badVersion = await call({ ...me, command: 'operations.status', apiVersion: 999 })
  ok(badVersion.status === 400, '能力服务：协议版本不一致被拒', JSON.stringify(badVersion.body))

  server.stop()
  const afterStop = await call({ ...me, command: 'operations.status' }).catch(() => null)
  ok(afterStop === null || afterStop.status >= 400, '能力服务：stop 后端点不再服务')

  await rm(opsDir, { recursive: true, force: true })
})
