/**
 * 砚对砚「本次连接」授权测试（需求稿第 6 节）。
 *
 * 只启动绑定 127.0.0.1 的临时 HTTP 服务；设备表写在临时目录，项目与会话数据全是假的，
 * 不启动 Electron、不连接 pi、不消耗模型额度。所有者的审批由测试直接调用 decide 模拟。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runPeerTests(ok, { RemoteServer, RemoteDeviceStore, PeerGrantRegistry }) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-peer-test-'))
  const devices = new RemoteDeviceStore(dir)
  /* 所有者的决定：测试里预先设定，ask 触发时立即作答 */
  let nextDecision = null
  const revokedStreams = []
  let server = null
  const grants = new PeerGrantRegistry({
    ask: (request) => {
      const decision = nextDecision ? nextDecision(request) : { requestId: request.requestId, approve: false, projectIds: [], operations: [] }
      setTimeout(() => grants.decide({ ...decision, requestId: request.requestId }), 5)
    },
    closed: () => undefined,
    changed: (_list, revoked) => {
      if (revoked) {
        revokedStreams.push(revoked)
        server?.disconnectConnection(revoked)
      }
    }
  })
  const commands = []
  const started = []
  server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    devices,
    handlers: {
      async snapshot() {
        return { sessions: [{ id: 's-a' }, { id: 's-b' }] }
      },
      async history(sessionId) {
        return { ok: true, data: { sessionId, messages: [{ id: 'm1', role: 'user', text: 'hi' }] } }
      },
      async command(command) {
        commands.push(command)
        return { ok: true, data: command }
      }
    },
    peers: {
      grants,
      handlers: {
        async projects() {
          return [
            { id: 'p-a', name: '项目 A' },
            { id: 'p-b', name: '项目 B' }
          ]
        },
        async sessions(projectIds) {
          return [
            { id: 's-a', projectId: 'p-a', title: 'A 会话' },
            { id: 's-b', projectId: 'p-b', title: 'B 会话' }
          ].filter((item) => projectIds.includes(item.projectId))
        },
        async projectOfSession(sessionId) {
          return sessionId === 's-a' ? 'p-a' : sessionId === 's-b' ? 'p-b' : null
        },
        async projectOfRun(runId) {
          return runId === 'r1' ? 'p-a' : runId === 'r2' ? 'p-b' : null
        },
        async exportSession(sessionId) {
          return { ok: true, data: { version: 1, source: { sessionId }, messages: [], artifacts: [] } }
        },
        async knowledge(projectId) {
          return { ok: true, data: { version: 1, source: { projectId }, entries: [] } }
        },
        async startSession(projectId, text) {
          started.push({ projectId, text })
          return { ok: true, data: { sessionId: 's-new', runId: 'r9', projectId } }
        }
      }
    }
  })

  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  const call = async (path, { token, connection, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(connection ? { 'x-yan-connection': connection } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  const pairAs = async (kind) => {
    const { code } = devices.startPairing()
    return (await call('/remote/v1/pair', { method: 'POST', body: { code, deviceName: kind, kind } })).body.token
  }
  /* 打开事件流并保持；返回关闭函数 */
  const openStream = async (token, connection) => {
    const controller = new AbortController()
    const response = await fetch(`${base}/remote/v1/peer/events`, {
      headers: { authorization: `Bearer ${token}`, 'x-yan-connection': connection },
      signal: controller.signal
    })
    const reader = response.ok ? response.body.getReader() : null
    if (reader) await reader.read()
    return { status: response.status, close: () => controller.abort() }
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  try {
    const phone = await pairAs('phone')
    const peer = await pairAs('peer')
    ok(typeof phone === 'string' && typeof peer === 'string', '砚对砚：手机与另一台砚都能用配对码配对')

    /* 身份与权限分开：peer 令牌本身访问不到手机路由，手机令牌也进不了 peer 路由 */
    ok((await call('/remote/v1/sessions', { token: peer })).status === 403, '砚对砚：peer 令牌不能访问手机路由')
    ok((await call('/remote/v1/events', { token: peer })).status === 403, '砚对砚：peer 令牌不能订阅桌面事件流')
    ok((await call('/remote/v1/peer/sessions', { token: phone })).status === 403, '砚对砚：手机令牌不能冒充 peer')
    ok((await call('/remote/v1/peer/sessions', { token: peer })).status === 401, '砚对砚：未申请连接时什么也读不到')

    /* 所有者拒绝 */
    nextDecision = () => ({ approve: false, projectIds: [], operations: [] })
    const denied = await call('/remote/v1/peer/connect', { token: peer, method: 'POST', body: { operations: ['read'] } })
    ok(denied.status === 403 && denied.body.code === 'peer_denied', '砚对砚：所有者拒绝时连接失败')

    /* 所有者批准：只开放项目 A、只允许查看（对方申请了查看和复制） */
    nextDecision = () => ({ approve: true, projectIds: ['p-a', 'p-not-offered'], operations: ['read', 'send'] })
    const approved = await call('/remote/v1/peer/connect', { token: peer, method: 'POST', body: { operations: ['read', 'transfer'], note: '看一下' } })
    const grant = approved.body.data?.grant
    ok(approved.status === 200 && grant?.projects.length === 1 && grant.projects[0].id === 'p-a', '砚对砚：授权只含所有者勾选且确实提供的项目')
    ok(grant?.operations.length === 1 && grant.operations[0] === 'read', '砚对砚：操作只能收窄到对方申请过的范围')

    ok((await call('/remote/v1/peer/sessions', { token: peer, connection: grant.connectionId })).status === 409, '砚对砚：事件流打开前授权不生效')
    const stream = await openStream(peer, grant.connectionId)
    ok(stream.status === 200, '砚对砚：批准后能打开事件流并激活授权')

    const list = await call('/remote/v1/peer/sessions', { token: peer, connection: grant.connectionId })
    ok(list.status === 200 && list.body.data.sessions.length === 1 && list.body.data.sessions[0].id === 's-a', '砚对砚：只列出开放项目里的会话')
    ok((await call('/remote/v1/peer/sessions/s-a', { token: peer, connection: grant.connectionId })).status === 200, '砚对砚：可以查看开放项目的会话')
    const other = await call('/remote/v1/peer/sessions/s-b', { token: peer, connection: grant.connectionId })
    ok(other.status === 403 && other.body.code === 'peer_project_denied', '砚对砚：未开放项目的会话被拒绝')
    const copy = await call('/remote/v1/peer/sessions/s-a/export', { token: peer, connection: grant.connectionId })
    ok(copy.status === 403 && copy.body.code === 'peer_operation_denied', '砚对砚：没有复制授权时导出被拒绝')
    const send = await call('/remote/v1/peer/sessions/s-a/messages', {
      token: peer,
      connection: grant.connectionId,
      method: 'POST',
      body: { text: '你好' },
      headers: { 'idempotency-key': 'peer-test-key-0001' }
    })
    ok(send.status === 403 && commands.length === 0, '砚对砚：没有发消息授权时不会执行')
    const startDenied = await call('/remote/v1/peer/projects/p-a/sessions', {
      token: peer,
      connection: grant.connectionId,
      method: 'POST',
      body: { text: '新任务' },
      headers: { 'idempotency-key': 'peer-test-key-0101' }
    })
    ok(startDenied.status === 403 && started.length === 0, '砚对砚：没有发消息授权时不能新开任务')
    ok((await call('/remote/v1/peer/projects/p-a/knowledge', { token: peer, connection: grant.connectionId })).status === 403, '砚对砚：没有复制授权时读不到项目记忆')

    /* 断开即失效：同一个连接 id 不能再用，也不能重新激活 */
    stream.close()
    await wait(80)
    ok(revokedStreams.includes(grant.connectionId), '砚对砚：事件流断开后授权被作废')
    ok((await call('/remote/v1/peer/sessions', { token: peer, connection: grant.connectionId })).status === 401, '砚对砚：断开后旧连接 id 立即失效')
    ok((await openStream(peer, grant.connectionId)).status === 401, '砚对砚：旧连接 id 不能重新激活（重连必须重新批准）')

    /* 重新申请：这次给复制与发消息，并测所有者撤销 */
    nextDecision = () => ({ approve: true, projectIds: ['p-a'], operations: ['read', 'transfer', 'send'] })
    const second = (await call('/remote/v1/peer/connect', { token: peer, method: 'POST', body: { operations: ['read', 'transfer', 'send'] } })).body.data.grant
    const stream2 = await openStream(peer, second.connectionId)
    ok(second.connectionId !== grant.connectionId && stream2.status === 200, '砚对砚：重新批准得到新的连接 id')
    ok((await call('/remote/v1/peer/sessions/s-a/export', { token: peer, connection: second.connectionId })).status === 200, '砚对砚：有复制授权时可以导出开放项目的会话')
    const sent = await call('/remote/v1/peer/sessions/s-a/messages', {
      token: peer,
      connection: second.connectionId,
      method: 'POST',
      body: { text: '你好' },
      headers: { 'idempotency-key': 'peer-test-key-0002' }
    })
    ok(sent.status === 200 && commands.length === 1 && commands[0].action === 'send', '砚对砚：授权范围内可以发消息')
    const abortOther = await call('/remote/v1/peer/runs/abort', {
      token: peer,
      connection: second.connectionId,
      method: 'POST',
      body: { runId: 'r2' },
      headers: { 'idempotency-key': 'peer-test-key-0003' }
    })
    ok(abortOther.status === 403 && commands.length === 1, '砚对砚：不能中止未开放项目里的任务')
    const startOther = await call('/remote/v1/peer/projects/p-b/sessions', {
      token: peer,
      connection: second.connectionId,
      method: 'POST',
      body: { text: '新任务' },
      headers: { 'idempotency-key': 'peer-test-key-0102' }
    })
    ok(startOther.status === 403 && started.length === 0, '砚对砚：不能在未开放的项目里新开任务')
    const startNoKey = await call('/remote/v1/peer/projects/p-a/sessions', {
      token: peer,
      connection: second.connectionId,
      method: 'POST',
      body: { text: '新任务' }
    })
    ok(startNoKey.status === 400 && started.length === 0, '砚对砚：新开任务必须带幂等键')
    const startOk = await call('/remote/v1/peer/projects/p-a/sessions', {
      token: peer,
      connection: second.connectionId,
      method: 'POST',
      body: { text: '新任务' },
      headers: { 'idempotency-key': 'peer-test-key-0103' }
    })
    ok(
      startOk.status === 200 && started.length === 1 && started[0].projectId === 'p-a' && startOk.body.data.sessionId === 's-new',
      '砚对砚：授权范围内可以在开放项目里新开任务'
    )
    const startAgain = await call('/remote/v1/peer/projects/p-a/sessions', {
      token: peer,
      connection: second.connectionId,
      method: 'POST',
      body: { text: '新任务' },
      headers: { 'idempotency-key': 'peer-test-key-0103' }
    })
    ok(startAgain.status === 200 && started.length === 1, '砚对砚：同一幂等键重试不会重复开任务')

    grants.revoke(second.connectionId)
    await wait(30)
    ok((await call('/remote/v1/peer/sessions', { token: peer, connection: second.connectionId })).status === 401, '砚对砚：所有者撤销后立即失效')
    stream2.close()

    /* 撤销设备：连接一并作废，令牌失效 */
    await devices.revoke((await devices.list()).find((item) => item.kind === 'peer').id)
    ok((await call('/remote/v1/peer/sessions', { token: peer })).status === 401, '砚对砚：撤销设备后令牌失效')
  } finally {
    await server.stop()
    grants.revokeAll()
    await rm(dir, { recursive: true, force: true })
  }
}
