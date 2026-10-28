import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandsOf, readYanCliGroups } from './helpers/yan-cli-groups.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'resources', 'yan-cli', 'yan.mjs')

function startTrap() {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body })
      const text = JSON.stringify({ ok: true, summary: { kind: 'trap' } })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text)
      })
      res.end(text)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, seen, url: `http://127.0.0.1:${addr.port}/rpc` })
    })
  })
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function fakeEnv(url) {
  return {
    ...process.env,
    YAN_CLI_URL: url,
    YAN_CLI_TOKEN: 'test-token',
    YAN_SESSION_ID: 'session-test',
    YAN_PROJECT_ID: 'project-test'
  }
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function runRetiredHubCliTests(ok, mod) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'yan-retired-hub-'))
  const trap = await startTrap()

  try {
    console.log('1) CLI 帮助与本地拦截')
    {
      const before = trap.seen.length
      const r = await runCli(['--help'], fakeEnv(trap.url))
      await settle()
      ok(r.status === 0, 'yan --help 退出码为 0', `status=${r.status}`)
      ok(r.stdout.includes('yan subagent start'), '帮助里有 subagent 入口')
      ok(!/^\s*yan hub/m.test(r.stdout), '帮助里不再宣告 hub.*')
      ok(trap.seen.length === before, '帮助路径不发任何请求')
    }

    const missingRequest = join(tmpDir, 'does-not-exist.json')
    const retiredCases = [
      ['hub', '--help'],
      ['hub', 'list'],
      ['hub', 'start', '--request-file', missingRequest]
    ]
    for (const args of retiredCases) {
      const before = trap.seen.length
      const r = await runCli(args, fakeEnv(trap.url))
      await settle()
      const text = `${r.stdout}${r.stderr}`
      const label = `yan ${args.join(' ')}`
      ok(r.status === 2, `${label} 以用法码退出`, `status=${r.status}`)
      ok(text.includes('\u5df2\u9000\u5f79') && text.includes('subagent'), `${label} 提示退役并指向 subagent`, text.slice(0, 200))
      ok(trap.seen.length === before, `${label} 不发请求`)
      if (args.includes('--request-file')) {
        ok(!text.includes('\u8bfb\u4e0d\u5230'), `${label} 在读取请求文件之前就返回`)
      }
    }

    {
      const env = fakeEnv(trap.url)
      delete env.YAN_CLI_URL
      delete env.YAN_CLI_TOKEN
      delete env.YAN_SESSION_ID
      delete env.YAN_PROJECT_ID
      const before = trap.seen.length
      const r = await runCli(['hub', 'list'], env)
      await settle()
      ok(r.status === 2 && `${r.stdout}${r.stderr}`.includes('\u5df2\u9000\u5f79'), '缺身份环境变量时仍先给退役提示')
      ok(trap.seen.length === before, '缺身份时退役调用也不发请求')
    }

    {
      const before = trap.seen.length
      const r = await runCli(['subagent', 'list'], fakeEnv(trap.url))
      await settle()
      ok(trap.seen.length === before + 1, '非退役命令仍发一次请求（拦截只针对 hub）')
      const captured = trap.seen[trap.seen.length - 1]
      const parsed = JSON.parse(captured.body)
      ok(parsed.command === 'subagent.list', '非退役命令的路由名不变', parsed.command)
      ok(r.status === 0, '假宿主回执 ok 时 CLI 退出码为 0', `status=${r.status}`)
    }

    {
      const before = trap.seen.length
      const r = await runCli(['subagent', 'send', '--id', 'sub-1a2b', '--message', '改查 src/main', '--mode', 'follow-up'], fakeEnv(trap.url))
      await settle()
      const parsed = JSON.parse(trap.seen[trap.seen.length - 1].body)
      ok(trap.seen.length === before + 1 && parsed.command === 'subagent.send', 'subagent send 路由到 subagent.send', parsed.command)
      ok(parsed.params.id === 'sub-1a2b' && parsed.params.message === '改查 src/main' && parsed.params.mode === 'follow-up', 'send 透传 id / message / mode', JSON.stringify(parsed.params))
      ok(r.status === 0, 'send 回执 ok 时退出码为 0', `status=${r.status}`)
      const missing = await runCli(['subagent', 'send', '--id', 'sub-1a2b'], fakeEnv(trap.url))
      await settle()
      ok(missing.status === 2 && trap.seen.length === before + 1, '缺 --message 时本地报用法错误，不发请求', `status=${missing.status}`)
    }

    console.log('2) 宿主白名单行为')
    const { CapabilityServer, CAPABILITY_API_VERSION } = mod
    const handled = []
    const server = new CapabilityServer({
      opsDir: join(tmpDir, 'ops'),
      handlers: {
        async run(command) {
          handled.push(command)
          return { data: {}, summary: { kind: 'probe' } }
        }
      }
    })
    const { url, token } = await server.start({ sessionId: 's', projectId: 'p' })
    ok(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/.test(url), '能力端点拿到合法回环端口', url)
    const rpc = async (command, params = {}) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            apiVersion: CAPABILITY_API_VERSION,
            sessionId: 's',
            projectId: 'p',
            command,
            params
          })
        })
        return await res.json()
      } catch (error) {
        return { ok: false, error: `能力端点请求失败：${error instanceof Error ? error.message : String(error)}（url=${url}）` }
      }
    }

    try {
      for (const cmd of ['hub.start', 'hub.list', 'hub.get', 'hub.stop', 'hub.handoff', 'hub.reply', 'hub.send']) {
        const before = handled.length
        const body = await rpc(cmd)
        ok(body.ok === false && body.code === 'retired_command', `${cmd} 被白名单拒绝并标记退役`, JSON.stringify(body))
        ok(String(body.error).includes('subagent'), `${cmd} 回执指向 subagent`)
        ok(handled.length === before, `${cmd} 未抵达 handler（不会拉起工作台进程）`)
      }

      {
        const body = await rpc('subagent.start', { task: 'probe' })
        ok(body.ok === true, 'subagent.start 仍在白名单')
        ok(handled[handled.length - 1] === 'subagent.start', 'subagent.start 抵达 handler')
        const sent = await rpc('subagent.send', { id: 'sub-1a2b', message: 'probe' })
        ok(sent.ok === true && handled[handled.length - 1] === 'subagent.send', 'subagent.send 在白名单并抵达 handler')
      }

      {
        const before = handled.length
        const body = await rpc('totally.unknown')
        ok(body.ok === false && !body.code && body.error === 'unknown_command', '普通未知命令仍回 unknown_command', JSON.stringify(body))
        ok(handled.length === before, '普通未知命令不抵达 handler')
      }
    } finally {
      server.stop()
    }

    const limited = new CapabilityServer({
      opsDir: join(tmpDir, 'ops-limited'),
      onlyCommands: ['search.query'],
      handlers: { async run() { return { data: {}, summary: { kind: 'probe' } } } }
    })
    const limitedEndpoint = await limited.start({ sessionId: 's', projectId: 'p' })
    try {
      const res = await fetch(limitedEndpoint.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${limitedEndpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, sessionId: 's', projectId: 'p', command: 'hub.start', params: {} })
      })
      const body = await res.json()
      ok(body.ok === false && body.error === 'unknown_command' && String(body.hint).includes('search.query') && !String(body.hint).includes('subagent'), '不能派子代理的会话里，hub.* 只提示本会话开放的命令', JSON.stringify(body))
    } finally {
      limited.stop()
    }
  } finally {
    trap.server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export async function runCapabilityResultTests(ok, mod) {
  const {
    CapabilityServer,
    CAPABILITY_API_VERSION,
    CAPABILITY_RESULT_MAX_BYTES,
    CAPABILITY_OPS_MAX_AGE_MS,
    CAPABILITY_OPS_MAX_FILES,
    CapabilityCommandError,
    KNOWN_COMMANDS
  } = mod
  ok(typeof CAPABILITY_RESULT_MAX_BYTES === 'number' && CAPABILITY_RESULT_MAX_BYTES > 0, '结果上限常量可用')
  ok(typeof KNOWN_COMMANDS?.has === 'function', '宿主导出命令白名单，供 CLI 对齐检查')
  ok(KNOWN_COMMANDS.has('search.docs'), 'CLI 承诺的 search docs 已登记进宿主白名单')

  const opsDir = mkdtempSync(join(tmpdir(), 'yan-ops-'))
  const server = new CapabilityServer({
    opsDir,
    handlers: {
      async run() {
        return { data: { big: 'x'.repeat(5 * 1024 * 1024), small: 1 }, summary: { kind: 'probe' } }
      }
    }
  })
  const { url, token } = await server.start({ sessionId: 's', projectId: 'p' })

  {
    const res = await fetch(url + '/rpc', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: CAPABILITY_API_VERSION,
        sessionId: 's',
        projectId: 'p',
        command: 'capabilities.search',
        params: {}
      })
    })
    const body = await res.json()
    ok(body.ok === true && typeof body.resultFile === 'string', '大结果仍然回执（带 resultFile）')
    ok(body.resultBytes <= CAPABILITY_RESULT_MAX_BYTES, '落盘字节数不超过上限')

    const raw = readFileSync(body.resultFile, 'utf8')
    let parsed
    let parseError = ''
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e)
    }
    ok(!parseError, `超限后的结果文件仍是合法 JSON（实际：${parseError || 'ok'}）`)
    ok(parsed?.truncated === true, '写明被截断')
    ok(typeof parsed?.bytes === 'number' && parsed.bytes > CAPABILITY_RESULT_MAX_BYTES, '写明原始大小')
    ok(
      parsed?.shape?.keys?.big?.type === 'string' && parsed.shape.keys.big.length === 5 * 1024 * 1024,
      '形状轮廓说清 big 是个 5MB 的字符串'
    )
    ok(typeof parsed?.head === 'string' && parsed.head.length <= 2000, '开头片段被夹住（不是把原文搬一遍）')
  }

  {
    let reentry = ''
    try {
      await server.start({ sessionId: 's', projectId: 'p' })
    } catch (error) {
      reentry = error instanceof Error ? error.message : String(error)
    }
    ok(/只服务一个会话/.test(reentry), '同一实例重复 start 直接拒绝，不静默换绑身份', reentry)
    server.stop()
  }

  {
    const groups = readYanCliGroups()
    const missing = []
    for (const group of groups) {
      for (const action of group.actions) {
        for (const command of commandsOf(group.group, action)) {
          if (!KNOWN_COMMANDS.has(command)) missing.push(command)
        }
      }
    }
    ok(missing.length === 0, `yan CLI 声明的命令都在宿主白名单里（缺：${missing.join(', ') || '无'}）`)
  }

  {
    const staleDir = mkdtempSync(join(tmpdir(), 'yan-ops-prune-'))
    const stale = join(staleDir, 'stale.json')
    const fresh = join(staleDir, 'fresh.json')
    const other = join(staleDir, 'notes.md')
    writeFileSync(stale, '{"old":true}', 'utf8')
    writeFileSync(fresh, '{"new":true}', 'utf8')
    writeFileSync(other, '# keep', 'utf8')
    const old = new Date(Date.now() - CAPABILITY_OPS_MAX_AGE_MS - 60_000)
    utimesSync(stale, old, old)
    const pruner = new CapabilityServer({ opsDir: staleDir })
    await pruner.start({ sessionId: 's', projectId: 'p' })
    const left = readdirSync(staleDir).sort()
    pruner.stop()
    ok(!left.includes('stale.json'), '启动时清掉 7 天前的结果文件', left.join(','))
    ok(left.includes('fresh.json'), '新的结果文件保留', left.join(','))
    ok(left.includes('notes.md'), '非结果文件不动', left.join(','))

    const manyDir = mkdtempSync(join(tmpdir(), 'yan-ops-many-'))
    for (let i = 0; i < CAPABILITY_OPS_MAX_FILES + 5; i++) writeFileSync(join(manyDir, `op-${i}.json`), '{}', 'utf8')
    const counter = new CapabilityServer({ opsDir: manyDir })
    await counter.start({ sessionId: 's', projectId: 'p' })
    const kept = readdirSync(manyDir).length
    counter.stop()
    ok(kept === CAPABILITY_OPS_MAX_FILES, `结果文件按上限保留（${CAPABILITY_OPS_MAX_FILES}）`, String(kept))
    ok(readdirSync(manyDir).includes(`op-${CAPABILITY_OPS_MAX_FILES + 4}.json`), '被保留的是最新的那批')
  }

  {
    const branchDir = mkdtempSync(join(tmpdir(), 'yan-ops-branch-'))
    const branch = new CapabilityServer({
      opsDir: branchDir,
      handlers: {
        async run(command) {
          if (command === 'capabilities.prepare') throw new CapabilityCommandError('probe_code', 'probe 失败', { detail: 'x' })
          return { data: { ok: true }, summary: { kind: 'probe' } }
        }
      }
    })
    const started = await branch.start({ sessionId: 's', projectId: 'p' })
    const call = async (body) => {
      const res = await fetch(started.url + '/rpc', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + started.token, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, sessionId: 's', projectId: 'p', ...body })
      })
      return { status: res.status, body: await res.json() }
    }
    try {
      const tooBig = await call({ command: 'capabilities.search', params: { pad: 'y'.repeat(1_200_000) } })
      ok(tooBig.status === 413 && tooBig.body.error === 'body_too_large', '超过 1MB 请求体回 413 body_too_large', JSON.stringify(tooBig.body))

      const noVersion = await call({ command: 'capabilities.search', apiVersion: 99 })
      ok(noVersion.status === 400 && noVersion.body.error === 'api_version_mismatch', '协议版本不符回 400', JSON.stringify(noVersion.body))

      const unknown = await call({ command: 'evil.exfiltrate' })
      ok(unknown.status === 400 && unknown.body.error === 'unknown_command', '未登记命令回 400 unknown_command', JSON.stringify(unknown.body))

      const retired = await call({ command: 'hub.start' })
      ok(
        retired.status === 400 && retired.body.code === 'retired_command' && /subagent/.test(String(retired.body.error)),
        '退役命令回可读的迁移提示',
        JSON.stringify(retired.body)
      )

      const forged = await call({ command: 'operations.status', projectId: 'p2' })
      ok(forged.status === 403 && forged.body.error === 'identity_mismatch', '身份不符回 403', JSON.stringify(forged.body))

      const failed = await call({ command: 'capabilities.prepare' })
      ok(
        failed.status === 200 && failed.body.ok === false && failed.body.code === 'probe_code' && typeof failed.body.resultFile === 'string',
        '命令失败仍回执错误码与附带数据',
        JSON.stringify(failed.body)
      )
      ok(
        JSON.parse(readFileSync(failed.body.resultFile, 'utf8'))?.detail === 'x',
        '错误附带数据落进结果文件'
      )

      const good = await call({ command: 'capabilities.search' })
      ok(good.status === 200 && good.body.ok === true && !('data' in good.body), '成功回执只给摘要与结果文件', JSON.stringify(good.body))

      const noResult = await call({ command: 'operations.status' })
      ok(noResult.status === 200 && typeof noResult.body.resultFile === 'string', 'operations.status 自带结果文件')

      const byId = await call({ command: 'operations.status', params: { id: good.body.operationId } })
      ok(byId.status === 200 && byId.body.ok === true, '传 id 查某一次操作', JSON.stringify(byId.body))
      const opFile = JSON.parse(readFileSync(byId.body.resultFile, 'utf8'))
      ok(
        opFile?.op?.id === good.body.operationId && opFile.op.command === 'capabilities.search' && opFile.op.resultFile === good.body.resultFile,
        'F10：operations.status 传 id 时真的按 id 返回那一条（而不是忽略 id 回最近列表）',
        JSON.stringify(opFile)
      )

      const missingId = await call({ command: 'operations.status', params: { id: 'no-such-op' } })
      ok(missingId.status === 200 && missingId.body.ok === false && missingId.body.code === 'operation_not_found', 'F10：传了不存在的 id 要明确报错', JSON.stringify(missingId.body))

      const raw = await fetch(started.url + '/rpc', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + started.token, 'content-type': 'application/json', connection: 'close' },
        body: 'not json'
      })
      const rawBody = await raw.json()
      ok(raw.status === 400 && rawBody.error === 'bad_json', '非法 JSON 回 400 bad_json', JSON.stringify(rawBody))
    } finally {
      branch.stop()
    }
  }

  await runRetiredHubCliTests(ok, mod)
}
