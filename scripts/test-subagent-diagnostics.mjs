/**
 * 子代理启动 / 退出诊断的定向回归（原生产类，不 spawn 真 pi、不花额度）。
 *
 * 覆盖：
 *   · 有界脱敏 stderr 尾部 + 退出码进入早退原因，而不是被压成「启动期间已停止」；
 *   · 启动失败（ENOENT）走 spawn-error，且 exit / spawn-error 重复只收口一次；
 *   · 人工停止与双 exit 不改写 cancelled 终态；
 *   · stderr 末尾没有换行、退出/close 时序下不丢尾行（真实 PiRpc + 假子进程）。
 *
 * 这里验证的是 src/main/subagents.ts 与 src/main/protocol.ts 的真实实现，
 * 不是复制一套测试内部逻辑。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagents.ts'],
    outfile: 'out/test/subagents-diagnostics.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/protocol.ts'],
    outfile: 'out/test/protocol-diagnostics.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

const { SubagentController, sanitizeStderrLine, describeProcessExit } = await import('../out/test/subagents-diagnostics.mjs')
const { PiRpc } = await import('../out/test/protocol-diagnostics.mjs')

const fakePrepare = async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd })

/** 假 pi 客户端：可注入 spawn 后的“真实”早退行为。 */
function makeRpcFactory(options = {}) {
  const created = []
  const createRpc = () => {
    const handlers = new Map()
    const rpc = {
      running: false,
      closed: false,
      on(event, listener) {
        const list = handlers.get(event) ?? []
        list.push(listener)
        handlers.set(event, list)
        return rpc
      },
      spawn() {
        rpc.running = true
        options.onSpawn?.(rpc)
      },
      async command(type) {
        if (type === 'get_state') return options.ready === false ? { success: false } : { success: true, data: {} }
        return { success: true }
      },
      async close() {
        rpc.running = false
        rpc.closed = true
      },
      emit(event, ...payload) {
        for (const listener of handlers.get(event) ?? []) listener(...payload)
      }
    }
    created.push(rpc)
    return rpc
  }
  return { created, createRpc }
}

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks += 1
}

/* 1. stderr 尾部 + 退出码 → 早退返回真实原因，且脱敏/截断。 */
{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-diag-'))
  const factory = makeRpcFactory({
    ready: false,
    onSpawn: (rpc) =>
      setTimeout(() => {
        rpc.running = false
        rpc.emit('stderr', 'connect failed: Authorization: Bearer sk-fakeSecretValue123')
        rpc.emit('stderr', 'model provider unavailable at https://user:pass@proxy.local/v1?access_token=sk-querySecret99')
        rpc.emit('stderr', 'x'.repeat(900))
        rpc.emit('exit', 3, null)
      }, 0)
  })
  const ctrl = new SubagentController({ cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc, onChange: () => {} })
  try {
    const res = await ctrl.start('诊断用任务', undefined, 'shared-cwd')
    ok(res.ok === false, '早退返回失败', JSON.stringify(res))
    ok(/code=3/.test(res.error), '早退原因带真实退出码', res.error)
    ok(/pi 子进程提前退出/.test(res.error), '早退原因说明进程提前退出', res.error)
    ok(res.error.includes('stderr'), '早退原因带 stderr 尾部', res.error)
    ok(!res.error.includes('sk-fakeSecretValue123'), 'sk- 凭证已脱敏', res.error)
    ok(!res.error.includes('sk-querySecret99') && !res.error.includes('user:pass'), 'URL 用户信息与查询密钥已脱敏', res.error)
    ok(res.error.length < 2000, '长 stderr 被截断，诊断不会无限增长', String(res.error.length))
    ok(!/启动期间已停止/.test(res.error), '有真实原因时不退化成「启动期间已停止」')
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

/* 2. 启动失败（ENOENT）+ 重复 exit / spawn-error 只收口一次。 */
{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-diag-'))
  const factory = makeRpcFactory({
    ready: false,
    onSpawn: (rpc) =>
      setTimeout(() => {
        rpc.running = false
        rpc.emit('spawn-error', new Error('spawn pi ENOENT'))
        rpc.emit('exit', null, null)
      }, 0)
  })
  const ctrl = new SubagentController({ cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc, onChange: () => {} })
  try {
    const res = await ctrl.start('启动失败任务', undefined, 'shared-cwd')
    ok(res.ok === false && /无法启动 pi/.test(res.error) && /ENOENT/.test(res.error), 'ENOENT 真实原因返回', res.error)
    const listed = ctrl.list()[0]
    ok(!!listed, '早退记录仍在运行列表中')
    const endedAt = listed.endedAt
    factory.created[0].emit('spawn-error', new Error('迟到的 ENOENT'))
    factory.created[0].emit('exit', 99, 'SIGKILL')
    const after = ctrl.list()[0]
    ok(after.status === 'error' && after.endReason === 'exited', '终态保持 error/exited', JSON.stringify(after))
    ok(after.endedAt === endedAt, '迟到事件不重写结束时间')
    ok(/无法启动 pi/.test(after.error) && !/99/.test(after.error), '迟到事件不覆盖真实启动原因', after.error)
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

/* 3. 人工停止 + 双 exit：保持 cancelled，且只通知一次。 */
{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-diag-'))
  const factory = makeRpcFactory({ ready: true })
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('停止任务', undefined, 'shared-cwd')
    ok(started.ok === true, '假 RPC 正常启动', started.error ?? '')
    const id = started.run.id
    await ctrl.stop(id)
    const stopped = ctrl.get(id)
    ok(stopped.status === 'cancelled' && stopped.endReason === 'stopped' && stopped.error === undefined, '人工停止是 cancelled/stopped 且无错误', JSON.stringify(stopped))
    factory.created[0].emit('exit', 0, null)
    factory.created[0].emit('exit', 1, null)
    const after = ctrl.get(id)
    ok(after.status === 'cancelled' && after.error === undefined, '迟到 exit 不覆盖 cancelled', JSON.stringify(after))
    await sleep(30)
    ok(finished === 1, '收口通知只发生一次', String(finished))
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

/* 4. 纯函数：脱敏、截断、空行。 */
{
  const key = sanitizeStderrLine('provider key sk-abcdef1234567890 here')
  ok(key.includes('[redacted]') && !key.includes('abcdef1234567890'), 'sk- 形状替换', key)
  const bearer = sanitizeStderrLine('Authorization: Bearer eyJhbGciOi.payload.sig')
  ok(!bearer.includes('eyJhbGciOi'), 'Bearer 形状替换', bearer)
  const url = sanitizeStderrLine('GET https://alice:hunter2@api.local/v1?token=SEKRET&x=1')
  ok(!url.includes('hunter2') && !url.includes('SEKRET') && url.includes('[redacted]@'), 'URL 凭证与查询密钥替换', url)
  const long = sanitizeStderrLine('y'.repeat(1000))
  ok(long.length < 600 && long.includes('共'), '单行截断并标注原长', String(long.length))
  ok(sanitizeStderrLine('   ') === undefined, '空白行不占一行')
  const described = describeProcessExit({ code: 7, signal: null }, ['boom'])
  ok(/code=7/.test(described) && /stderr：boom/.test(described), 'describeProcessExit 拼接退出码与 stderr', described)
  const spawn = describeProcessExit({ spawnError: 'spawn pi ENOENT' }, [])
  ok(/无法启动 pi/.test(spawn) && !/code=/.test(spawn), 'spawn 错误优先且不重复退出码', spawn)
}

/* 5. 真实 PiRpc + 假子进程：末尾无换行的 stderr 与退出码都不丢。 */
{
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-protocol-diag-'))
  const childPath = join(dir, 'fake-pi.mjs')
  await writeFile(childPath, "process.stderr.write('warn: sk-rawSecretValue123\\n')\nprocess.stderr.write('tail-without-newline')\nprocess.exit(7)\n", 'utf8')
  try {
    const rpc = new PiRpc({ cwd: dir, runtime: { kind: 'node', executable: process.execPath, cli: childPath } })
    const events = []
    rpc.on('stderr', (line) => events.push(`stderr:${line}`))
    rpc.on('exit', (code) => events.push(`exit:${code}`))
    rpc.spawn()
    const started = Date.now()
    while (!events.some((e) => e.startsWith('exit:')) && Date.now() - started < 10_000) await sleep(20)
    ok(events.includes('stderr:tail-without-newline'), '没有末尾换行的 stderr 尾行不丢', JSON.stringify(events))
    ok(events[events.length - 1] === 'exit:7', '收口在 stderr 之后且带真实退出码', JSON.stringify(events))
    ok(events.filter((e) => e.startsWith('exit:')).length === 1, 'exit 只发一次', JSON.stringify(events))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* 6. 真实 PiRpc + 不存在的可执行文件：spawn-error 先于 exit 且只收口一次。 */
{
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-protocol-diag-'))
  try {
    const rpc = new PiRpc({ cwd: dir, runtime: { kind: 'native-exe', executable: join(dir, 'no-such-pi-bin.exe') } })
    const events = []
    rpc.on('spawn-error', (err) => events.push(`spawn-error:${err.message}`))
    rpc.on('exit', () => events.push('exit'))
    rpc.spawn()
    const started = Date.now()
    while (!events.includes('exit') && Date.now() - started < 10_000) await sleep(20)
    ok(events.filter((e) => e === 'exit').length === 1, 'spawn 失败也只发一次 exit', JSON.stringify(events))
    ok(/ENOENT/.test(events[0] ?? ''), 'spawn-error 带 ENOENT 原因', JSON.stringify(events))
    ok(events.indexOf(events.find((e) => e.startsWith('spawn-error'))) < events.indexOf('exit'), 'spawn-error 先于 exit', JSON.stringify(events))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* 7. 本地统一脱敏：JSON 字段（单/双引号）、HTTP 头、Basic/Bearer、URL 与查询参数。 */
{
  const jsonDouble = sanitizeStderrLine('{"api_key":"dummy-local-credential"}')
  ok(jsonDouble.includes('[redacted]') && !jsonDouble.includes('dummy-local-credential'), 'JSON 双引号字段脱敏', jsonDouble)
  const jsonSingle = sanitizeStderrLine("{'token': 'dummy-local-credential'}")
  ok(jsonSingle.includes('[redacted]') && !jsonSingle.includes('dummy-local-credential'), '单引号字段脱敏', jsonSingle)
  const jsonAuth = sanitizeStderrLine('{"Authorization":"Basic ZHVtbXk6c2VjcmV0"}')
  ok(!jsonAuth.includes('ZHVtbXk6c2VjcmV0') && jsonAuth.includes('[redacted]'), 'JSON Authorization/Basic 脱敏', jsonAuth)
  const header = sanitizeStderrLine('X-API-Key: dummy-local-credential')
  ok(header.includes('[redacted]') && !header.includes('dummy-local-credential'), 'X-API-Key 头脱敏', header)
  const basic = sanitizeStderrLine('Authorization: Basic ZHVtbXk6c2VjcmV0')
  ok(!basic.includes('ZHVtbXk6c2VjcmV0'), '裸 Basic 头脱敏', basic)
  const bearer = sanitizeStderrLine('Authorization: Bearer ZHVtbXktYmVhcmVy')
  ok(!bearer.includes('ZHVtbXktYmVhcmVy'), '裸 Bearer 头脱敏', bearer)
  const query = sanitizeStderrLine('GET https://api.local/v1?api_key=querySecret123&page=2')
  ok(!query.includes('querySecret123') && query.includes('page=2'), '查询参数密钥脱敏且不误伤普通参数', query)
  const userinfo = sanitizeStderrLine('POST https://alice:hunter2@api.local/v1')
  ok(!userinfo.includes('hunter2') && userinfo.includes('[redacted]@'), 'URL userinfo 脱敏', userinfo)
  const longValue = sanitizeStderrLine('{"token":"' + 'z'.repeat(40) + '"}')
  ok(longValue.includes('[redacted]') && !longValue.includes('zzzz'), '长引号值整体替换，不拼接碎片', longValue)
  const spawnRedacted = describeProcessExit({ spawnError: 'spawn pi: {"api_key":"dummy-local-credential"}' }, [])
  ok(!spawnRedacted.includes('dummy-local-credential') && /无法启动 pi/.test(spawnRedacted), '拒绝启动原因也走本地统一脱敏', spawnRedacted)
}

/* 8. 启动错误存前脱敏：快照与历史文件都不含原始凭证。 */
{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-diag-'))
  const secret = 'dummy-local-credential'
  const factory = makeRpcFactory({
    ready: false,
    onSpawn: (rpc) =>
      setTimeout(() => {
        rpc.running = false
        rpc.emit('spawn-error', new Error(`spawn failed: {"api_key":"${secret}"} X-API-Key: ${secret} Authorization: Basic ZHVtbXk6c2VjcmV0`))
        rpc.emit('exit', null, null)
      }, 0)
  })
  const ctrl = new SubagentController({ cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc, onChange: () => {} })
  try {
    const res = await ctrl.start('启动脱敏任务', undefined, 'shared-cwd')
    ok(res.ok === false, '带凭证的启动错误返回失败', JSON.stringify(res))
    const id = ctrl.list()[0]?.id
    const serialized = JSON.stringify(ctrl.get(id))
    ok(!serialized.includes(secret), '快照不含原始 spawnError 凭证', serialized.slice(0, 300))
    ok(!serialized.includes('ZHVtbXk6c2VjcmV0'), '快照不含 Basic 凭据串', serialized.slice(0, 300))
    await sleep(80)
    const files = await readdir(archive)
    const historyFile = files.find((f) => f.endsWith('.json'))
    ok(!!historyFile, '启动错误也写了历史', JSON.stringify(files))
    if (historyFile) {
      const raw = await readFile(join(archive, historyFile), 'utf8')
      ok(!raw.includes(secret) && !raw.includes('ZHVtbXk6c2VjcmV0'), '历史文件不含原始启动凭证')
    }
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

/* 9. 真实 PiRpc：超长无换行 stderr 有界并明确标注截断。 */
{
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-protocol-long-'))
  const childPath = join(dir, 'fake-long-stderr.mjs')
  await writeFile(childPath, "process.stderr.write('L'.repeat(200000))\nsetTimeout(() => process.exit(0), 20)\n", 'utf8')
  try {
    const rpc = new PiRpc({ cwd: dir, runtime: { kind: 'node', executable: process.execPath, cli: childPath } })
    const events = []
    rpc.on('stderr', (line) => events.push(line))
    rpc.on('exit', () => events.push('__exit__'))
    rpc.spawn()
    const started = Date.now()
    while (!events.includes('__exit__') && Date.now() - started < 10_000) await sleep(20)
    const lines = events.filter((e) => e !== '__exit__')
    ok(lines.length >= 1, '超长无换行 stderr 至少交出一条诊断', String(lines.length))
    const maxLen = Math.max(...lines.map((e) => e.length), 0)
    ok(maxLen <= 16 * 1024 + 80, '单条诊断有界', String(maxLen))
    ok(lines.some((e) => e.includes('已截断')), '截断有明确标注', JSON.stringify(lines.map((e) => e.slice(0, 20))))
    ok(events[events.length - 1] === '__exit__', '超长 stderr 后仍单次收口', JSON.stringify(events.slice(-2)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* 10. 后代进程暂持 pipe：真实 exit 立即失活，有限宽限内收口，不等后代生命周期。 */
{
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-protocol-grandchild-'))
  const pidFile = join(dir, 'gc.pid')
  const childPath = join(dir, 'fake-pipe-holder.mjs')
  await writeFile(
    childPath,
    [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true })",
      'writeFileSync(process.env.PID_FILE, String(gc.pid))',
      "process.stderr.write('tail-without-newline-from-parent')",
      'process.exit(0)'
    ].join('\n'),
    'utf8'
  )
  let gcPid = null
  try {
    const rpc = new PiRpc({ cwd: dir, env: { PID_FILE: pidFile }, runtime: { kind: 'node', executable: process.execPath, cli: childPath } })
    const events = []
    rpc.on('stderr', (line) => events.push(`stderr:${line}`))
    rpc.on('exit', (code) => events.push(`exit:${code}`))
    const started = Date.now()
    rpc.spawn()
    while (!events.some((e) => e.startsWith('exit:')) && Date.now() - started < 5_000) await sleep(20)
    const elapsed = Date.now() - started
    ok(events.includes('stderr:tail-without-newline-from-parent'), '后代持 pipe 时尾行仍交出', JSON.stringify(events))
    ok(events.some((e) => e.startsWith('exit:')), '后代持 pipe 时仍收口', JSON.stringify(events))
    ok(elapsed < 1_000, `收口不等待后代完整生命周期（${elapsed}ms）`)
    ok(rpc.running === false, '真实 exit 后 running 立即为 false')
    gcPid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
    ok(Number.isFinite(gcPid) && gcPid > 0, '拿到后代 PID 以便只清理自己', String(gcPid))
    let alive = true
    try {
      process.kill(gcPid, 0)
    } catch {
      alive = false
    }
    ok(alive, '收口时后代仍存活，证明没有等它')
  } finally {
    if (gcPid) {
      try {
        process.kill(gcPid)
      } catch {
        /* 后代已自行退出 */
      }
    }
    // 后代还占着工作目录时 Windows 会 EBUSY：等它退出并重试删除。
    await sleep(200)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/* 11. 真实 PiRpc：延迟到达的多段 stderr 拼成一行，收口在最后一条之后。 */
{
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-protocol-delayed-'))
  const childPath = join(dir, 'fake-delayed-stderr.mjs')
  await writeFile(childPath, "process.stderr.write('partial-')\nsetTimeout(() => { process.stderr.write('tail\\n'); process.exit(4) }, 100)\n", 'utf8')
  try {
    const rpc = new PiRpc({ cwd: dir, runtime: { kind: 'node', executable: process.execPath, cli: childPath } })
    const events = []
    rpc.on('stderr', (line) => events.push(`stderr:${line}`))
    rpc.on('exit', (code) => events.push(`exit:${code}`))
    rpc.spawn()
    const started = Date.now()
    while (!events.some((e) => e.startsWith('exit:')) && Date.now() - started < 10_000) await sleep(20)
    ok(events.includes('stderr:partial-tail'), '延迟多段 stderr 拼成一行', JSON.stringify(events))
    ok(events[events.length - 1] === 'exit:4', '尾行之后才收口并带退出码', JSON.stringify(events))
    ok(events.filter((e) => e.startsWith('exit:')).length === 1, 'exit 只发一次', JSON.stringify(events))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(`subagent-diagnostics: ${checks} assertions passed（本机假进程，未调用真实模型）`)
