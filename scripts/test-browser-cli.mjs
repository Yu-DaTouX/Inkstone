import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { spawnSync } = await import('node:child_process')

  console.log('\n--- 01-S4b 浏览器 CLI ---')

  const { CapabilityServer, CAPABILITY_API_VERSION } = await compile('src/main/capability-server.ts')
  const opsDir = await mkdtemp(join(tmpdir(), 'yan-browser-ops-'))
  const seen = []
  const server = new CapabilityServer({
    opsDir,
    handlers: {
      run: async (command, params) => {
        seen.push(command)
        return { data: { command, params }, summary: { kind: 'browser', action: command.slice(8), ok: true } }
      }
    }
  })
  const { url, token } = await server.start({ sessionId: 's-b', projectId: 'p-b' })
  const call = async (command, params = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: CAPABILITY_API_VERSION,
        command,
        params,
        sessionId: 's-b',
        projectId: 'p-b'
      })
    })
    return { status: res.status, body: await res.json() }
  }
  const navigate = await call('browser.navigate', { url: 'about:blank' })
  ok(
    navigate.status === 200 && navigate.body.ok === true && seen[0] === 'browser.navigate',
    '能力服务：browser.navigate 已登记并落到 handler',
    JSON.stringify(navigate.body).slice(0, 120)
  )
  const network = await call('browser.network')
  ok(
    network.status === 200 && network.body.ok === true && seen[1] === 'browser.network',
    '能力服务：browser.network 已登记并落到 handler',
    JSON.stringify(network.body).slice(0, 120)
  )
  const evaluate = await call('browser.evaluate', { script: '1+1' })
  ok(
    evaluate.status === 400 && evaluate.body.error === 'unknown_command',
    '能力服务：browser.evaluate 有意不登记（不提供任意页面 JavaScript）'
  )
  server.stop()
  await rm(opsDir, { recursive: true, force: true })

  const env = { ...process.env }
  for (const key of ['YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) delete env[key]
  const runYan = (args) =>
    spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', ...args], { encoding: 'utf8', env })
  const jsonOf = (stdout) => {
    const line = String(stdout)
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('{'))
      .pop()
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }
  const looksLikeStack = (text) => /\n\s+at\s+\S/.test(text) || /\bat\s+\S+\s+\(\S+:\d+:\d+\)/.test(text)

  const typo = runYan(['browser', 'frobnicate'])
  const typoBody = jsonOf(typo.stderr)
  ok(typo.status === 2, 'yan CLI：未知子命令走用法退出码 2')
  ok(/未知的 browser 子命令/.test(String(typoBody?.error ?? '')), 'yan CLI：未知子命令给中文提示')
  ok(!looksLikeStack(typo.stderr ?? ''), 'yan CLI：未知子命令不抛堆栈')

  const missingArg = runYan(['browser', 'navigate'])
  const missingBody = jsonOf(missingArg.stderr)
  ok(missingArg.status === 2, 'yan CLI：漏参数走用法退出码 2')
  ok(/--url/.test(String(missingBody?.error ?? '')), 'yan CLI：漏参数指出缺哪个 flag')
  ok(!looksLikeStack(missingArg.stderr ?? ''), 'yan CLI：漏参数不抛堆栈')

  const noHost = runYan(['browser', 'observe'])
  ok(noHost.status === 3, 'yan CLI：没有宿主环境变量时走「不可用」退出码 3')
  ok(/宿主能力服务不可用/.test(noHost.stderr ?? ''), 'yan CLI：说明是宿主不可用（不是命令不存在）')

}, { isolate: true })
