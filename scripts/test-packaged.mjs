#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = process.env.YAN_PACKAGED_DIR
  ? resolve(process.env.YAN_PACKAGED_DIR)
  : join(root, 'release', 'win-unpacked')

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`
}

function fail(msg, extra = '') {
  console.error(`\n${C.err('✗')} ${msg}`)
  if (extra) console.error(C.dim(extra))
  process.exit(1)
}

function terminatePackagedProcesses(marker) {
  if (process.platform !== 'win32') return
  const markerBase64 = Buffer.from(marker, 'utf8').toString('base64')
  const script = [
    '$marker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' + JSON.stringify(markerBase64) + '))',
    '$all = @(Get-CimInstance Win32_Process)',
    '$ids = New-Object System.Collections.Generic.HashSet[uint32]',
    'foreach ($p in $all) { if (($p.CommandLine -as [string]) -like ("*" + $marker + "*")) { [void]$ids.Add([uint32]$p.ProcessId) } }',
    '[void]$ids.Remove([uint32]$PID)',
    '$changed = $true',
    'while ($changed) {',
    '  $changed = $false',
    '  foreach ($p in $all) {',
    '    $isPackaged = ($p.Name -as [string]) -like "砚*.exe"',
    '    if ($isPackaged -and $ids.Contains([uint32]$p.ProcessId) -and $p.ParentProcessId) { $parent = $all | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1; if ($parent -and (($parent.Name -as [string]) -like "砚*.exe") -and $ids.Add([uint32]$p.ParentProcessId)) { $changed = $true } }',
    '    if ($isPackaged -and $ids.Contains([uint32]$p.ParentProcessId)) { if ($ids.Add([uint32]$p.ProcessId)) { $changed = $true } }',
    '  }',
    '}',
    'foreach ($p in $all) { if ($ids.Contains([uint32]$p.ProcessId) -and -not $ids.Contains([uint32]$p.ParentProcessId)) { & taskkill.exe /PID ([string]$p.ProcessId) /T /F *> $null } }'
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000
    })
  } catch {
  }
}

if (process.platform !== 'win32') fail('这个脚本目前只支持 Windows（先做 Windows 分发）')

const argExe = process.argv.find((a) => a.startsWith('--exe='))?.slice('--exe='.length)
const exeFromArg = argExe ? resolve(argExe) : null

if (!exeFromArg && !existsSync(unpacked)) {
  fail('找不到打包目录', '设置 YAN_PACKAGED_DIR，或先跑：npm run dist:dir（或 npm run dist:check）')
}

let exePath
if (exeFromArg) {
  if (!existsSync(exeFromArg)) fail(`--exe 指向的文件不存在：${exeFromArg}`)
  exePath = exeFromArg
} else {
  const exes = readdirSync(unpacked).filter((f) => f.toLowerCase().endsWith('.exe'))
  if (!exes.length) fail(`打包目录里没有 .exe`, unpacked)
  exePath = join(unpacked, exes[0])
}

console.log(`${C.b('▸')} 打包产物验收`)
console.log(C.dim(`  ${exePath}`))

const must = [
  ['pi-runtime', join(unpacked, 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')],
  ['pi-runtime node_modules', join(unpacked, 'resources', 'pi-runtime', 'node_modules')],
  ['Codemode WASM', join(unpacked, 'resources', 'pi-runtime', 'node_modules', 'quickjs-wasi', 'quickjs.wasm')],
  ['Codemode worker', join(unpacked, 'resources', 'pi-runtime', 'dist', 'bundle', 'chunks', 'codemode-worker.js')],
  ['Codemode desktop policy', join(unpacked, 'resources', 'yan-thin', 'codemode-policy.js')],
  ['yan-cli', join(unpacked, 'resources', 'yan-cli', 'yan.mjs')],
  ['yan-thin', join(unpacked, 'resources', 'yan-thin', 'question.js')],
  ['app.asar', join(unpacked, 'resources', 'app.asar')]
]
if (exeFromArg) {
  console.log(C.dim('  （--exe 模式：跳过 win-unpacked 静态检查，只跑探针）'))
} else {
  for (const [label, p] of must) {
    if (!existsSync(p)) fail(`extraResources 缺件：${label}`, p)
  }
  console.log(`  ${C.ok('✓')} extraResources 落位（pi-runtime / yan-thin / yan-cli / app.asar）`)
}
const sandbox = mkdtempSync(join(process.env.YAN_PACKAGED_TMP_DIR ? resolve(process.env.YAN_PACKAGED_TMP_DIR) : tmpdir(), 'yan-packaged-'))
if (!exeFromArg) {
  const standalone = join(sandbox, 'app')
  cpSync(unpacked, standalone, { recursive: true })
  exePath = join(standalone, basename(exePath))
  console.log(C.dim(`  独立目录副本：${exePath}`))
}
if (exeFromArg && basename(exePath).toLowerCase().includes('portable')) {
  const sandboxExe = join(sandbox, basename(exePath))
  copyFileSync(exePath, sandboxExe)
  exePath = sandboxExe
  console.log(C.dim(`  便携副本：${exePath}`))
}
const dirs = {
  YAN_USER_DATA: join(sandbox, 'userData'),
  YAN_SESSIONS_DIR: join(sandbox, 'sessions'),
  YAN_DATA_DIR: join(sandbox, 'data'),
  YAN_PI_DIR: join(sandbox, 'pi-agent')
}
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

const gitRepo = join(sandbox, 'gitrepo')
mkdirSync(gitRepo, { recursive: true })
const gitRun = (args, cwd = gitRepo) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
gitRun(['init', '-q'])
gitRun(['config', 'user.email', 'pkg-probe@local'])
gitRun(['config', 'user.name', 'pkg-probe'])
writeFileSync(join(gitRepo, 'tracked.txt'), 'one\n', 'utf8')
gitRun(['add', 'tracked.txt'])
gitRun(['commit', '-q', '-m', 'init'])
writeFileSync(join(gitRepo, 'tracked.txt'), 'one\ntwo\n', 'utf8')
const gitPristine = gitRun(['status', '--porcelain']).stdout.trim()
if (gitPristine !== 'M tracked.txt' && gitPristine !== ' M tracked.txt') {
  fail('临时 git 仓库的初始状态不对', `status = ${JSON.stringify(gitPristine)}`)
}
const gitNumstat = gitRun(['diff', '--numstat']).stdout.trim()
if (gitNumstat !== '1\t0\ttracked.txt') {
  fail('临时 git 仓库的改动数量与预期不符', `numstat = ${JSON.stringify(gitNumstat)}`)
}

writeFileSync(
  join(dirs.YAN_DATA_DIR, 'desktop.json'),
  JSON.stringify({
    cwd: root,
    lang: 'zh-CN',
    projects: [
      {
        id: 'pkg-git-repo',
        cwd: gitRepo,
        name: 'pkg-git-repo',
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]
  }),
  'utf8'
)
console.log(C.dim(`  隔离目录 ${sandbox}`))

const LEGACY_SENTINELS = [
  { name: 'memory.json', body: '{"entries":[{"id":"old-1","text":"用户遗留的旧记忆，不许被删除或改写"}]}\n' },
  { name: 'soul.md', body: '# soul\n\n用户遗留的旧人设文件，逐字节不许变。\n' }
]
for (const base of [dirs.YAN_PI_DIR, dirs.YAN_DATA_DIR]) {
  for (const sentinel of LEGACY_SENTINELS) writeFileSync(join(base, sentinel.name), sentinel.body, 'utf8')
}
const delay = 9000
const outFile = join(sandbox, 'probe.txt')

const INHERITED_KEYS = ['ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'NODE_OPTIONS', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']
const cleanEnv = (extra = {}) => {
  const env = { ...process.env }
  for (const k of INHERITED_KEYS) delete env[k]
  return { ...env, ...extra }
}

const debugPort = 9300 + Math.floor(Math.random() * 600)
const probeEnv = cleanEnv({
  ...dirs,
  YAN_PROBE_DEBUG_PORT: String(debugPort),
  YAN_PROBE: join(root, 'scripts', 'probe', 'packaged.js'),
  YAN_PROBE_DELAY: String(delay),
  YAN_PROBE_OUT: outFile
})
const listenersOn = (port) => {
  try {
    return new Set(
      execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING')
        .map((cols) => cols[4])
    )
  } catch {
    return new Set()
  }
}
const remoteListenersBefore = listenersOn(37892)
const child = spawn(exePath, [
  `--yan-probe=${join(root, 'scripts', 'probe', 'packaged.js')}`,
  `--yan-probe-delay=${delay}`,
  `--yan-probe-out=${outFile}`,
  `--user-data-dir=${dirs.YAN_USER_DATA}`,
  `--yan-user-data=${dirs.YAN_USER_DATA}`,
  `--yan-sessions-dir=${dirs.YAN_SESSIONS_DIR}`,
  `--yan-data-dir=${dirs.YAN_DATA_DIR}`,
  `--yan-pi-dir=${dirs.YAN_PI_DIR}`
], {
  cwd: sandbox,
  env: probeEnv,
  windowsHide: true
})

let buf = ''
child.stdout.on('data', (d) => (buf += d))
child.stderr.on('data', (d) => (buf += d))

const remoteDefaultPort = 37892
const remoteProbe = new Promise((resolveProbe) => {
  setTimeout(() => {
    const req = httpRequest(
      { host: '127.0.0.1', port: remoteDefaultPort, path: '/remote/v1/health', method: 'GET', timeout: 2000 },
      (res) => {
        res.resume()
        resolveProbe({ reachable: true, status: res.statusCode })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolveProbe({ reachable: false, why: 'timeout' })
    })
    req.on('error', (err) => resolveProbe({ reachable: false, why: err.code ?? err.message }))
    req.end()
  }, 4000)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + delay + 150_000
let body = null
while (Date.now() < deadline) {
  if (existsSync(outFile)) {
    const txt = readFileSync(outFile, 'utf8').trim()
    if (txt) {
      body = txt
      break
    }
  }
  const m = /---PROBE-START---\r?\n([\s\S]*?)\r?\n---PROBE-END---/.exec(buf)
  if (m) {
    body = m[1]
    break
  }
  await sleep(500)
}

const cdpEvaluate = (wsUrl, expression) => new Promise((resolveEval) => {
  const socket = new WebSocket(wsUrl)
  const timer = setTimeout(() => {
    socket.close()
    resolveEval('求值超时（渲染进程主线程可能卡住）')
  }, 5000)
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data))
    if (reply.id !== 1) return
    clearTimeout(timer)
    socket.close()
    resolveEval(JSON.stringify(reply.result?.result?.value ?? reply.result?.exceptionDetails ?? reply.error ?? null))
  }
  socket.onerror = () => {
    clearTimeout(timer)
    resolveEval('调试连接失败')
  }
})

const startupDiagnosis = async () => {
  const lines = []
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
    if (!targets.length) lines.push('调试端口在，但没有任何页面')
    for (const target of targets) {
      lines.push(`${target.type} ${target.url}`)
      if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue
      lines.push(`  ${await cdpEvaluate(target.webSocketDebuggerUrl, `({ readyState: document.readyState, visibility: document.visibilityState, rootChildren: document.getElementById('root')?.childElementCount ?? null, text: (document.body?.innerText ?? '').slice(0, 800) })`)}`)
    }
  } catch (error) {
    lines.push(`调试端口不可用：${error?.message ?? error}`)
  }
  lines.push(`进程：${child.exitCode === null ? `仍在运行 pid=${child.pid}` : `已退出 code=${child.exitCode} signal=${child.signalCode}`}`)
  if (child.exitCode === null) {
    const windowScript = join(sandbox, 'window-titles.ps1')
    writeFileSync(windowScript, [
      'param([string]$AppDirectory)',
      'Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($AppDirectory, [StringComparison]::OrdinalIgnoreCase) } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress'
    ].join('\n'))
    const titles = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', windowScript, dirname(exePath)], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    lines.push(`窗口：\n${titles.stdout?.trim() || titles.stderr?.trim() || titles.error?.message || '无窗口信息'}`)
  }
  const unpackedModules = join(dirname(exePath), 'resources', 'app.asar.unpacked', 'node_modules')
  const nativeScript = join(sandbox, 'native-load.cjs')
  writeFileSync(nativeScript, [
    "for (const name of ['ffi-rs', '@ff-labs/fff-node']) {",
    "  try { require(require('node:path').join(process.argv[2], name)); console.log(name + ' 加载成功') }",
    "  catch (error) { console.log(name + ' 加载失败：' + (error.stack || error)) }",
    '}'
  ].join('\n'))
  const nativeLoad = spawnSync(exePath, [nativeScript, unpackedModules], { cwd: sandbox, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: cleanEnv({ ...dirs, ELECTRON_RUN_AS_NODE: '1' }) })
  lines.push(`原生依赖：\n${`${nativeLoad.stdout ?? ''}${nativeLoad.stderr ?? ''}`.trim() || `无输出 status=${nativeLoad.status} error=${nativeLoad.error?.message ?? ''}`}`)
  for (const base of [dirs.YAN_USER_DATA, dirs.YAN_DATA_DIR, dirs.YAN_PI_DIR]) {
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !(/\.log$/i.test(entry.name) || entry.name === 'last-exit.json')) continue
      const path = join(entry.parentPath ?? entry.path, entry.name)
      lines.push(`--- ${path}`)
      lines.push(readFileSync(path, 'utf8').slice(-1500))
    }
  }
  return lines.join('\n')
}

const diagnosis = body == null ? await startupDiagnosis() : ''

child.kill()
terminatePackagedProcesses(sandbox)
await sleep(600)

const runChecks = []
if (!exeFromArg) {
  const binDir = join(dirs.YAN_DATA_DIR, 'bin')
  const cmdPath = join(binDir, 'yan.cmd')
  const shPath = join(binDir, 'yan')
  runChecks.push([existsSync(cmdPath), `启动器已生成（${cmdPath}）`])
  runChecks.push([existsSync(shPath), `POSIX 启动器已生成（${shPath}）`])
  if (existsSync(cmdPath)) {
    const txt = readFileSync(cmdPath, 'utf8')
    const cliInUnpacked = join(dirname(exePath), 'resources', 'yan-cli', 'yan.mjs')
    runChecks.push([txt.includes(cliInUnpacked), '启动器指向解包目录里的 yan.mjs（不是开发态仓库路径）'])
    runChecks.push([/ELECTRON_RUN_AS_NODE/.test(txt), '启动器用应用自带运行时（ELECTRON_RUN_AS_NODE=1）'])
  }
  if (existsSync(cmdPath) && body != null) {
    const norm = (s) => s.replace(/[\\/]+/g, '\\')
    runChecks.push([
      norm(readFileSync(cmdPath, 'utf8')).includes(norm(join(dirname(exePath), 'resources', 'yan-cli', 'yan.mjs'))),
      '启动器里的 CLI 路径与安装目录逐段一致'
    ])
  }
}

{
  const porcelain = gitRun(['status', '--porcelain']).stdout.trim()
  runChecks.push([
    /^M {2}tracked\.txt$/m.test(porcelain),
    `包内 stage 真的写进了 index（git status → ${JSON.stringify(porcelain)}）`
  ])
}

if (!exeFromArg) {
  const asarPath = join(unpacked, 'resources', 'app.asar')
  const unpackedModules = join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules')
  const mustUnpacked = [
    ['fff-node', join(unpackedModules, '@ff-labs', 'fff-node', 'dist', 'index.cjs')],
    ['fff 原生库', join(unpackedModules, '@ff-labs', 'fff-bin-win32-x64', 'fff_c.dll')],
    ['ffi-rs 绑定', join(unpackedModules, '@yuuang', 'ffi-rs-win32-x64-msvc', 'ffi-rs.win32-x64-msvc.node')]
  ]
  for (const [label, p] of mustUnpacked) runChecks.push([existsSync(p), `文件搜索原生依赖已解包：${label}`])
  if (existsSync(asarPath)) {
    const asar = readFileSync(asarPath)
    for (const [needle, label] of [
      ['session-chains.json', '会话链文件名'],
      ['worktree-links.json', '工作树来源关系表（实施-07 S2a）'],
      ['/remote/v1/health', '远程管理路由（实施-08 第一阶段）']
    ]) {
      runChecks.push([asar.includes(needle), `包内含 ${label}（${needle}）`])
    }
  } else {
    runChecks.push([false, 'app.asar 存在（静态索引检查的前提）'])
  }
}

{
  const probe = await remoteProbe
  const newListeners = [...listenersOn(remoteDefaultPort)].filter((pid) => !remoteListenersBefore.has(pid))
  const preexisting = remoteListenersBefore.size > 0
  runChecks.push([
    preexisting ? newListeners.length === 0 : probe.reachable === false,
    preexisting
      ? `远程服务默认不监听（${remoteDefaultPort} 已被测试前就在的进程 ${[...remoteListenersBefore].join(',')} 占用；被测实例没有新增监听）`
      : `远程服务默认不监听（127.0.0.1:${remoteDefaultPort} 连不上：${probe.why ?? 'ok'}）`
  ])
}

{
  const remotePort = 37957
  const remoteToken = 'pkg-probe-token-0123456789'
  const remoteDirs = {
    YAN_USER_DATA: join(sandbox, 'remote-userData'),
    YAN_SESSIONS_DIR: join(sandbox, 'remote-sessions'),
    YAN_DATA_DIR: join(sandbox, 'remote-data'),
    YAN_PI_DIR: join(sandbox, 'remote-pi')
  }
  for (const d of Object.values(remoteDirs)) mkdirSync(d, { recursive: true })
  const remoteChild = spawn(exePath, [
    `--user-data-dir=${remoteDirs.YAN_USER_DATA}`,
    `--yan-user-data=${remoteDirs.YAN_USER_DATA}`,
    `--yan-sessions-dir=${remoteDirs.YAN_SESSIONS_DIR}`,
    `--yan-data-dir=${remoteDirs.YAN_DATA_DIR}`,
    `--yan-pi-dir=${remoteDirs.YAN_PI_DIR}`
  ], {
    cwd: sandbox,
    windowsHide: true,
    env: cleanEnv({
      ...remoteDirs,
      YAN_REMOTE_ENABLE: '1',
      YAN_REMOTE_PORT: String(remotePort),
      YAN_REMOTE_TOKEN: remoteToken
    })
  })
  const hit = async (path, token) => {
    try {
      const res = await fetch(`http://127.0.0.1:${remotePort}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(2500)
      })
      return res.status
    } catch {
      return 0
    }
  }
  let health = 0
  for (let i = 0; i < 80 && health !== 200; i += 1) {
    await sleep(700)
    health = await hit('/remote/v1/health')
  }
  runChecks.push([health === 200, `显式开启后远程服务起得来（/health → ${health || '连不上'}）`])
  const noToken = await hit('/remote/v1/status')
  runChecks.push([noToken === 401, `不带 token 打 /status 被拒（${noToken}）`])
  const withToken = await hit('/remote/v1/status', remoteToken)
  runChecks.push([withToken === 200, `带 token 打 /status 通过（${withToken}）`])
  remoteChild.kill()
  terminatePackagedProcesses(sandbox)
  await sleep(600)
}

if (!exeFromArg) {
  const cliPath = join(unpacked, 'resources', 'yan-cli', 'yan.mjs')
  if (existsSync(cliPath)) {
    const r = spawnSync(exePath, [cliPath, '--help'], {
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    runChecks.push([r.status === 0, `解包里的 yan.mjs 能跑（--help 退出码 ${r.status}）`])
    runChecks.push([/yan — 砚宿主能力 CLI/.test(out), '打出了自己的用法说明'])
    runChecks.push([/tasks apply/.test(out), '用法里含任务写入（模型能从 help 里发现它）'])
    runChecks.push([/mcp describe/.test(out), '用法里含 MCP describe（模型能从 help 里发现它）'])
    const rMcp = spawnSync(exePath, [cliPath, 'mcp', 'describe', '--server', 'x', '--tool', 'y'], {
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    const outMcp = `${rMcp.stdout ?? ''}${rMcp.stderr ?? ''}`
    runChecks.push([rMcp.status === 3, `无宿主环境下 mcp describe 报宿主不可用（退出码 ${rMcp.status}）`])
    runChecks.push([/宿主能力服务不可用/.test(outMcp), 'mcp 在无宿主时报可读原因（不是堆栈）'])
    runChecks.push([!/\n\s+at\s+\S/.test(outMcp), 'mcp 无宿主时不吐 Node 堆栈'])

    const r2 = spawnSync(exePath, [cliPath, 'tasks', 'apply'], {
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    const out2 = `${r2.stdout ?? ''}${r2.stderr ?? ''}`
    runChecks.push([r2.status !== 0, `无宿主环境下 tasks apply 不报成功（退出码 ${r2.status}）`])
    runChecks.push([/宿主能力服务不可用/.test(out2), '报的是「宿主服务不可用」这个可读原因'])
    runChecks.push([/YAN_CLI_URL/.test(out2), '说明了缺哪些环境（不是笼统的「执行失败」）'])
  } else {
    runChecks.push([false, '解包目录里找不到 resources/yan-cli/yan.mjs'])
  }
}

{
  for (const base of [dirs.YAN_PI_DIR, dirs.YAN_DATA_DIR]) {
    for (const sentinel of LEGACY_SENTINELS) {
      const path = join(base, sentinel.name)
      let same = false
      try {
        same = readFileSync(path, 'utf8') === sentinel.body
      } catch {
        same = false
      }
      runChecks.push([same, `旧用户数据逐字节不变：${basename(base)}/${sentinel.name}`])
    }
  }
}

if (body == null) {
  terminatePackagedProcesses(sandbox)
  console.error(`\n${C.err('✗')} 没拿到 PROBE 输出 —— 打包后的应用可能启动失败`)
  console.error(C.dim(buf.slice(-3000) || '(child 没有任何输出，也没写结果文件)'))
  console.error(`\n启动诊断：\n${diagnosis}`)
  console.error(C.dim(`隔离现场已保留：${sandbox}`))
  process.exit(1)
}

body = body.trim()
console.log('\n' + body)

let runFailed = false
if (runChecks.length) {
  console.log(`\n${C.b('▸')} 随包能力入口（运行时）`)
  for (const [ok2, label] of runChecks) {
    if (!ok2) runFailed = true
    console.log(`  ${ok2 ? C.ok('✓') : C.err('✗')} ${label}`)
  }
}

if (/✗/.test(body) || runFailed) {
  terminatePackagedProcesses(sandbox)
  console.error(`\n${C.err('✗ 打包验收失败')}`)
  console.error(C.dim(`隔离现场已保留：${sandbox}`))
  process.exit(1)
}
terminatePackagedProcesses(sandbox)
await sleep(600)
rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${C.ok('✓ 打包验收通过')} ${C.dim('内置 pi 在安装目录里可用')}`)
