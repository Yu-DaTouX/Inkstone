#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'resources', 'yan-cli', 'yan.mjs')
const serverSource = join(repoRoot, 'src', 'main', 'capability-server.ts')

let passed = 0
let failed = 0
function ok(cond, label, detail) {
  if (cond) {
    passed++
    console.log(`  \u2713 ${label}`)
  } else {
    failed++
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

async function compileCapabilityServer(tmpDir) {
  const { build } = await import(
    pathToFileURL(join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  )
  const outfile = join(tmpDir, 'capability-server.mjs')
  await build({
    entryPoints: [serverSource],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

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

async function main() {
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
    const mod = await compileCapabilityServer(tmpDir)
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
  } finally {
    trap.server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

await main()
