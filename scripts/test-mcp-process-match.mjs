import './lib/test-isolate.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

await runSuite(import.meta.url, async (ok, compile) => {
  const match = await compile('src/main/mcp/native-process-match.ts', { packages: 'external' })
  const tree = await compile('src/main/process-tree.ts', { packages: 'external' })
  const { matchNativeServer, tokenizeCommandLine, readNativeSpawnSpecs, nativeMcpSelector } = match

  ok(tokenizeCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\x.js" --flag').join('|') === 'C:\\Program Files\\nodejs\\node.exe|C:\\a b\\x.js|--flag', '命令行按引号拆分')

  const specs = [
    { name: 'codegraph', command: 'codegraph', args: ['serve', '--mcp'] },
    { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'] },
    { name: 'mine', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\tools\\my-server.js', '--stdio'] },
    { name: 'bare-node', command: 'node', args: ['-v'] },
    { name: 'bare', command: 'node', args: [] }
  ]
  const hit = (commandLine) => matchNativeServer({ commandLine }, specs)?.name ?? null
  ok(hit('cmd /d /s /c "codegraph serve --mcp"') === 'codegraph', 'cmd 包装器里的命令行按服务配置匹配')
  ok(hit('"C:\\Windows\\System32\\cmd.exe" /d /s /c ""C:\\npm\\codegraph.cmd" serve --mcp"') === 'codegraph', '带引号的 .cmd 入口也匹配')
  ok(hit('cmd.exe /d /s /c "npx -y @modelcontextprotocol/server-filesystem C:\\work"') === 'fs', 'npx 起的服务按完整参数匹配')
  ok(hit('"C:\\Program Files\\nodejs\\node.exe" C:\\tools\\my-server.js --stdio') === 'mine', '直接由 node 起的服务匹配（路径斜杠写法不影响）')
  ok(hit('cmd /c codegraph index .') === null, '同一个程序但参数不同（codegraph index）不匹配')
  ok(hit('cmd /c "npx vite --port 5173"') === null, 'dev server（npx vite）不匹配')
  ok(hit('node server.js') === null, '只有裸 node 的配置不能当作白名单：普通 node 进程不匹配')
  ok(hit('node -v') === null, '只有选项参数的通用运行时配置同样不匹配')
  ok(hit('"C:\\Program Files\\Microsoft Office\\EXCEL.EXE" /e') === null, 'GUI 程序不匹配')
  ok(hit('cmd /c start excel.exe report.xlsx') === null, 'start 打开的程序不匹配')
  ok(hit('bash.exe -c "codegraph serve --mcp"') === null, '被 bash 工具包着的同名命令不算（可执行文件必须一致）')
  ok(matchNativeServer({}, specs) === null, '读不到命令行时不匹配')

  const dir = mkdtempSync(join(tmpdir(), 'yan-mcp-match-'))
  const spawned = []
  try {
    const agentDir = join(dir, 'agent')
    const project = join(dir, 'project')
    mkdirSync(join(project, '.pi'), { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { g: { command: 'codegraph', args: ['serve', '--mcp'] }, remote: { url: 'https://x.test/mcp' }, off: { command: 'foo', args: ['-x'], enabled: false } } }))
    writeFileSync(join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { p: { command: 'uvx', args: ['mcp-server-git'] }, over: { enabled: false } } }))
    const read = readNativeSpawnSpecs(agentDir, project)
    ok(read.map((spec) => spec.name).sort().join() === 'g,off,p', '读取全局与项目级配置里带 command 的服务，网络服务与纯覆盖项不计')
    const select = nativeMcpSelector({ agentDir, cwd: project })
    ok(select({ commandLine: 'cmd /c uvx mcp-server-git' }) === true && select({ commandLine: 'cmd /c uvx ruff' }) === false, '选择器同时认项目级配置')
    ok(readNativeSpawnSpecs(join(dir, 'missing')).length === 0, '配置文件不存在时没有可匹配的服务')

    if (process.platform === 'win32') {
      const idle = "setInterval(() => {}, 1000)"
      const pidWriter = (name) => `require('node:fs').writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, String(process.pid))\n${idle}\n`
      const files = {}
      for (const name of ['mcp-a', 'mcp-b', 'dev', 'gui']) {
        files[name] = join(dir, `${name}.cjs`)
        writeFileSync(files[name], pidWriter(name))
      }
      const mcpConfig = join(dir, 'agent2')
      mkdirSync(mcpConfig, { recursive: true })
      writeFileSync(join(mcpConfig, 'mcp.json'), JSON.stringify({ mcpServers: {
        a: { command: process.execPath, args: [files['mcp-a'], '--mcp-stdio'] },
        b: { command: 'node', args: [files['mcp-b'], '--mcp-stdio'] }
      } }))
      const fakePi = join(dir, 'fake-pi.cjs')
      writeFileSync(fakePi, [
        "const { spawn } = require('node:child_process')",
        `const q = (s) => '"' + s + '"'`,
        `spawn('cmd.exe', ['/d', '/s', '/c', '"' + q(${JSON.stringify(process.execPath)}) + ' ' + q(${JSON.stringify(files['mcp-a'])}) + ' --mcp-stdio"'], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })`,
        `spawn('cmd.exe', ['/d', '/s', '/c', '"' + q('node') + ' ' + q(${JSON.stringify(files['mcp-b'])}) + ' --mcp-stdio"'], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })`,
        `spawn('cmd.exe', ['/d', '/s', '/c', '"' + q(${JSON.stringify(process.execPath)}) + ' ' + q(${JSON.stringify(files.dev)}) + '"'], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true, detached: true })`,
        `spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(files.gui)}], { stdio: 'ignore', windowsHide: true, detached: true })`,
        idle
      ].join('\n'))
      const spawnedAt = Date.now()
      const pi = spawn(process.execPath, [fakePi], { stdio: 'ignore', windowsHide: true, env: { ...process.env, PATH: process.env.PATH } })
      spawned.push(pi.pid)
      const bystander = spawn(process.execPath, ['-e', idle], { stdio: 'ignore', windowsHide: true })
      spawned.push(bystander.pid)
      const pidOf = (name) => Number(readFileSync(join(dir, `${name}.pid`), 'utf8'))
      ok(await waitFor(() => ['mcp-a', 'mcp-b', 'dev', 'gui'].every((name) => existsSync(join(dir, `${name}.pid`)) && readFileSync(join(dir, `${name}.pid`), 'utf8').length > 0), 20_000), '假 pi 起了两个 MCP 服务、一个 dev server 和一个 GUI 程序')
      const pids = Object.fromEntries(['mcp-a', 'mcp-b', 'dev', 'gui'].map((name) => [name, pidOf(name)]))
      spawned.push(...Object.values(pids))

      const skipped = []
      const watch = new tree.ProcessTreeWatch(pi.pid, {
        listProcesses: tree.listWindowsProcesses,
        now: () => spawnedAt,
        select: nativeMcpSelector({ agentDir: mcpConfig, cwd: project }),
        onSkipped: (rows) => skipped.push(...rows)
      })
      await watch.snapshot()
      const tracked = watch.trackedPids()
      ok(tracked.includes(pids['mcp-a']) && tracked.includes(pids['mcp-b']), '快照只记下匹配上配置的 MCP 服务进程（含 cmd 包装器之下的）', tracked.join())
      ok(!tracked.includes(pids.dev) && !tracked.includes(pids.gui), 'dev server 与 GUI 程序没有被记下', tracked.join())

      const exited = new Promise((resolve) => pi.once('exit', resolve))
      pi.kill()
      await exited
      watch.markExited(Date.now())
      ok(await waitFor(() => alive(pids['mcp-a']) || alive(pids['mcp-b']), 2000), 'pi 退出后 MCP 服务的孙进程成为孤儿，仍在运行')
      const swept = await watch.sweep()
      ok(swept.includes(pids['mcp-a']) && swept.includes(pids['mcp-b']), '结束时扫到了匹配的 MCP 服务', swept.join())
      ok(await waitFor(() => !alive(pids['mcp-a']) && !alive(pids['mcp-b']), 8000), 'MCP 服务进程已被结束')
      ok(alive(pids.dev), 'pi 起的 dev server 没被结束')
      ok(alive(pids.gui), 'pi 起的 GUI 程序没被结束')
      ok(alive(bystander.pid), '无关进程没被结束')
      ok(skipped.length > 0 && skipped.every((row) => row.pid !== pids['mcp-a'] && row.pid !== pids['mcp-b']), '没匹配上的子进程只记入日志，不动', skipped.map((row) => `${row.name}(${row.pid})`).join())
      ok(!skipped.some((row) => row.pid === pi.pid), '日志列表里没有 pi 自己')
    }
  } finally {
    for (const pid of spawned) {
      try {
        process.kill(pid)
      } catch {
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
  }
})
