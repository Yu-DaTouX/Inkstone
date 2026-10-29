import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runPeerTests(ok, { RemoteServer, RemoteDeviceStore, PeerGrantRegistry }) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-peer-test-'))
  const devices = new RemoteDeviceStore(dir)
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
  const peerGraceMs = 120
  server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    devices,
    peerGraceMs,
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

    {
      const { code } = devices.startPairing()
      const named = await call('/remote/v1/pair', { method: 'POST', body: { code, deviceName: 'Inkstone · DESKTOP-ABC', kind: 'peer' } })
      ok(named.status === 200 && (await devices.list()).some((item) => item.name === 'DESKTOP-ABC'), '砚对砚：新配对只存计算机名，不再带 Inkstone 前缀')
    }

    {
      const legacyDir = join(dir, 'legacy-devices')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(join(legacyDir, 'remote-devices.json'), JSON.stringify({
        version: 1,
        devices: [
          { id: 'device-old-1', name: '砚 · 老电脑', kind: 'peer', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: 'a'.repeat(64) },
          { id: 'device-old-2', name: 'Inkstone · LAPTOP-X', kind: 'phone', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: 'b'.repeat(64) },
          { id: 'device-old-3', name: '别的名字', kind: 'phone', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: 'c'.repeat(64) }
        ]
      }), 'utf8')
      const legacy = new RemoteDeviceStore(legacyDir)
      const names = (await legacy.list()).map((item) => item.name)
      ok(names.join(',') === '老电脑,LAPTOP-X,别的名字', '旧设备表里的砚 / Inkstone 前缀读入时去掉，其它名字不变')
    }

    ok((await call('/remote/v1/sessions', { token: peer })).status === 403, '砚对砚：peer 令牌不能访问手机路由')
    ok((await call('/remote/v1/events', { token: peer })).status === 403, '砚对砚：peer 令牌不能订阅桌面事件流')
    ok((await call('/remote/v1/peer/sessions', { token: phone })).status === 403, '砚对砚：手机令牌不能冒充 peer')
    ok((await call('/remote/v1/peer/sessions', { token: peer })).status === 401, '砚对砚：未申请连接时什么也读不到')

    nextDecision = () => ({ approve: false, projectIds: [], operations: [] })
    const denied = await call('/remote/v1/peer/connect', { token: peer, method: 'POST', body: { operations: ['read'] } })
    ok(denied.status === 403 && denied.body.code === 'peer_denied', '砚对砚：所有者拒绝时连接失败')

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

    stream.close()
    await wait(80)
    ok(!revokedStreams.includes(grant.connectionId), '砚对砚：事件流断开先进入宽限期，不立即作废授权')
    ok((await call('/remote/v1/peer/sessions', { token: peer, connection: grant.connectionId })).status === 200, '砚对砚：宽限期内旧连接仍可继续用')
    const resumed = await openStream(peer, grant.connectionId)
    ok(resumed.status === 200, '砚对砚：同一条连接可重连并复用原授权')
    resumed.close()
    await wait(peerGraceMs + 120)
    ok(revokedStreams.includes(grant.connectionId), '砚对砚：宽限期结束后授权被作废')
    ok((await call('/remote/v1/peer/sessions', { token: peer, connection: grant.connectionId })).status === 401, '砚对砚：宽限期结束后旧连接 id 失效')

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

    const peer2Ids = new Set((await devices.list()).map((item) => item.id))
    const peer2 = await pairAs('peer')
    const peer2DeviceId = (await devices.list()).find((item) => !peer2Ids.has(item.id)).id
    nextDecision = () => ({ approve: true, projectIds: ['p-a'], operations: ['read'] })
    const own = (await call('/remote/v1/peer/connect', { token: peer2, method: 'POST', body: { operations: ['read'] } })).body.data.grant
    const ownStream = await openStream(peer2, own.connectionId)
    ok(ownStream.status === 200 && grants.list().some((item) => item.connectionId === own.connectionId), '砚对砚：第二台另一台砚拿到自己的连接授权')

    const foreign = await call('/remote/v1/peer/disconnect', { token: peer2, method: 'POST', body: { connectionId: second.connectionId } })
    ok(foreign.status === 200, '砚对砚：断开接口对不属于自己的连接也返回 ok')
    ok(
      grants.list().some((item) => item.connectionId === second.connectionId) &&
        (await call('/remote/v1/peer/sessions', { token: peer, connection: second.connectionId })).status === 200,
      '砚对砚：别的设备不能撤销我的连接'
    )

    const ended = await call('/remote/v1/peer/disconnect', { token: peer2, method: 'POST', body: { connectionId: own.connectionId } })
    ok(
      ended.status === 200 && !grants.list().some((item) => item.connectionId === own.connectionId),
      '砚对砚：对方主动断开后授权立即消失，不必等宽限期'
    )
    ok((await call('/remote/v1/peer/sessions', { token: peer2, connection: own.connectionId })).status === 401, '砚对砚：主动断开后旧连接 id 立即失效')
    ok(revokedStreams.includes(own.connectionId), '砚对砚：主动断开时事件流一起关闭')
    ownStream.close()
    ok((await call('/remote/v1/peer/disconnect', { token: peer2, method: 'POST', body: { connectionId: own.connectionId } })).status === 200, '砚对砚：重复断开幂等')
    ok((await call('/remote/v1/peer/disconnect', { token: peer2, method: 'POST', body: {} })).status === 200, '砚对砚：没有 connectionId 也返回 ok')
    ok((await call('/remote/v1/peer/disconnect', { token: phone, method: 'POST', body: { connectionId: own.connectionId } })).status === 403, '砚对砚：手机令牌不能调用断开接口')

    const selfRevoke = await call('/remote/v1/devices/self/revoke', { token: peer2, method: 'POST', body: {} })
    ok(selfRevoke.status === 200, '砚对砚：另一端撤回配对时服务端接受')
    ok(!grants.list().some((item) => item.deviceId === peer2DeviceId), '砚对砚：撤回配对时这台设备的全部授权一起撤销')
    ok((await call('/remote/v1/peer/sessions', { token: peer2 })).status === 401, '砚对砚：撤回配对后令牌立即失效')

    grants.revoke(second.connectionId)
    await wait(30)
    ok((await call('/remote/v1/peer/sessions', { token: peer, connection: second.connectionId })).status === 401, '砚对砚：所有者撤销后立即失效')
    stream2.close()

    await devices.revoke((await devices.list()).find((item) => item.kind === 'peer').id)
    ok((await call('/remote/v1/peer/sessions', { token: peer })).status === 401, '砚对砚：撤销设备后令牌失效')
  } finally {
    await server.stop()
    grants.revokeAll()
    await rm(dir, { recursive: true, force: true })
  }
}
