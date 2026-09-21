#!/usr/bin/env node
/**
 * 打包产物验收：跑 release/win-unpacked 里的**真实应用**，
 * 在渲染端执行 scripts/probe/packaged.js。
 *
 * 用法：
 *   npm run dist:dir         先产出 release/win-unpacked
 *   npm run test:packaged    再验收（不烧 token）
 *   npm run dist:check       上面两步一起
 *
 * 为什么开发态的 30 个场景不够：它们跑的是 `npx electron .`，
 * 读的是仓库里的 `resources/pi-runtime`。打包后 pi 改从
 * `process.resourcesPath/` 找 —— 路径错了应用**能启动但连不上**，
 * 开发态测试全绿也照样复现不了。这个脚本就是专门补那个缝。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = join(root, 'release', 'win-unpacked')

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

/*
 * electron-builder 的 Windows portable wrapper 会把真正的 Electron 主进程
 * 脱离 wrapper 留在后台；`child.kill()` 只结束外层自解压器，不能递归结束
 * GPU / renderer / pi 子进程。若不在验收结束时按本次 sandbox 标记收口，
 * 临时目录会被这些进程占用，最后的 rmSync 会把一次成功探针误报成 EPERM。
 *
 * 这里仅按本次随机 sandbox 路径寻找进程，并把命中的进程向上补到宿主、向下
 * 补齐子树；不会按进程名泛杀，也不会碰真实用户的 Electron 或本地模型进程。
 */
function terminatePackagedProcesses(marker) {
  if (process.platform !== 'win32') return
  /* Keep the literal sandbox path out of PowerShell's own command line; otherwise
     the discovery pass would see the cleanup helper as another target. */
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
    /* Only walk the packaged app image. The portable wrapper is also named 砚*.exe,
       while the current Node test runner must never be pulled into the kill set. */
    '    $isPackaged = ($p.Name -as [string]) -like "砚*.exe"',
    '    if ($isPackaged -and $ids.Contains([uint32]$p.ProcessId) -and $p.ParentProcessId) { $parent = $all | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1; if ($parent -and (($parent.Name -as [string]) -like "砚*.exe") -and $ids.Add([uint32]$p.ParentProcessId)) { $changed = $true } }',
    '    if ($isPackaged -and $ids.Contains([uint32]$p.ParentProcessId)) { if ($ids.Add([uint32]$p.ProcessId)) { $changed = $true } }',
    '  }',
    '}',
    /* Kill from each packaged root so Windows also tears down renderer/GPU/pi
       descendants that do not carry the sandbox path in their own argv. */
    'foreach ($p in $all) { if ($ids.Contains([uint32]$p.ProcessId) -and -not $ids.Contains([uint32]$p.ParentProcessId)) { & taskkill.exe /PID ([string]$p.ProcessId) /T /F *> $null } }'
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000
    })
  } catch {
    /* cleanup is best effort; the final directory removal remains the evidence */
  }
}

/* 0. 前置：打包产物在不在 */
if (process.platform !== 'win32') fail('这个脚本目前只支持 Windows（先做 Windows 分发）')

/*
 * `--exe=<路径>` 可直接验证单个可执行文件（如 portable 单文件版）：
 * 它会自解压到临时目录再跑，extraResources 的静态检查不适用，只跑探针。
 */
const argExe = process.argv.find((a) => a.startsWith('--exe='))?.slice('--exe='.length)
const exeFromArg = argExe ? resolve(argExe) : null

if (!exeFromArg && !existsSync(unpacked)) {
  fail('找不到 release/win-unpacked', '先跑：npm run dist:dir（或 npm run dist:check）')
}

let exePath
if (exeFromArg) {
  if (!existsSync(exeFromArg)) fail(`--exe 指向的文件不存在：${exeFromArg}`)
  exePath = exeFromArg
} else {
  const exes = readdirSync(unpacked).filter((f) => f.toLowerCase().endsWith('.exe'))
  if (!exes.length) fail(`release/win-unpacked 里没有 .exe`)
  exePath = join(unpacked, exes[0])
}

console.log(`${C.b('▸')} 打包产物验收`)
console.log(C.dim(`  ${exePath}`))

/* 1. extraResources 必须真的落在安装目录里 */
const must = [
  ['pi-runtime', join(unpacked, 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')],
  ['pi-runtime node_modules', join(unpacked, 'resources', 'pi-runtime', 'node_modules')],
  /*
   * 实施-02 S5：随包 `yan` CLI 也必须进安装目录。
   * 它不在 app.asar 里（那是代码），而是 extraResources（模型要从磁盘直接跑它）。
   * 漏了它的症状是：应用能启动、模型一敲 `yan` 就「不是内部或外部命令」。
   */
  ['yan-cli', join(unpacked, 'resources', 'yan-cli', 'yan.mjs')],
  ['app.asar', join(unpacked, 'resources', 'app.asar')]
]
if (exeFromArg) {
  console.log(C.dim('  （--exe 模式：跳过 win-unpacked 静态检查，只跑探针）'))
} else {
  for (const [label, p] of must) {
    if (!existsSync(p)) fail(`extraResources 缺件：${label}`, p)
  }
  console.log(`  ${C.ok('✓')} extraResources 落位（pi-runtime / yan-cli / app.asar）`)
}
/* 2. 隔离沙盒（绕不开真实会话、派生状态与 localStorage） */
const sandbox = mkdtempSync(join(tmpdir(), 'yan-packaged-'))
/*
 * 便携 wrapper 会把 PORTABLE_EXECUTABLE_DIR 指向被启动 EXE 的同级目录。
 * 不能直接从 release/ 启动它，否则真实的 release/砚数据/会被测试写入。
 * 把单文件复制到本次沙盒后再启动，便携数据也会随现场一起保留。
 */
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

/*
 * 2a. 一个**真的** git 仓库（实施-07 的包内写操作证据用）。
 *
 * 为何不能在开发仓库或用户仓库里验：写操作会真的改工作区——只能在一个临时仓库里做。
 * 它同时是「项目列表」里的一项，所以渲染端能像用户选项目那样选到它。
 */
const gitRepo = join(sandbox, 'gitrepo')
mkdirSync(gitRepo, { recursive: true })
const gitRun = (args, cwd = gitRepo) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
gitRun(['init', '-q'])
gitRun(['config', 'user.email', 'pkg-probe@local'])
gitRun(['config', 'user.name', 'pkg-probe'])
writeFileSync(join(gitRepo, 'tracked.txt'), 'one\n', 'utf8')
gitRun(['add', 'tracked.txt'])
gitRun(['commit', '-q', '-m', 'init'])
/* 制造一个未暂存的改动：探针要把它 stage 掉 */
writeFileSync(join(gitRepo, 'tracked.txt'), 'one\ntwo\n', 'utf8')
const gitPristine = gitRun(['status', '--porcelain']).stdout.trim()
if (gitPristine !== 'M tracked.txt' && gitPristine !== ' M tracked.txt') {
  fail('临时 git 仓库的初始状态不对', `status = ${JSON.stringify(gitPristine)}`)
}
/*
 * 这次改动的**数量**先由 Node 侧算一次。下面探针里的审查断言
 * （`tracked.txt` 增 1 行、删 0 行、新增行文本是 `two`）必须与它一致 ——
 * 否则「审查面板读到了真实改动」就只在探针自己的说法里成立。
 */
const gitNumstat = gitRun(['diff', '--numstat']).stdout.trim()
/* git 的 numstat 是 `<新增行>\t<删除行>\t<路径>`：这里是 `one` → `one\ntwo`，所以新增 1 行。 */
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

/*
 * 2b. 旧用户数据哨兵 + 项目知识 fixture（实施-03 S6）。
 *
 * 哨兵：实施-03 §9 要求「用户遗留的 `memory.json` / `soul.md` **不主动删**」。
 * 光看「应用没报错」证明不了 —— 只有跑完前**逐字节**比对才算。
 *
 * 知识 fixture：让打包后的实例真的去读一次项目知识，从而能验证
 * 「解包实例的读写落在 `YAN_DIR`，不落在安装目录 / 开发目录」。
 * projectId 用**旧算法**：这就是打包实例自己会算出来的那个（cwd 自动登记）。
 */
const LEGACY_SENTINELS = [
  { name: 'memory.json', body: '{"entries":[{"id":"old-1","text":"用户遗留的旧记忆，不许被删除或改写"}]}\n' },
  { name: 'soul.md', body: '# soul\n\n用户遗留的旧人设文件，逐字节不许变。\n' }
]
for (const base of [dirs.YAN_PI_DIR, dirs.YAN_DATA_DIR]) {
  for (const sentinel of LEGACY_SENTINELS) writeFileSync(join(base, sentinel.name), sentinel.body, 'utf8')
}
const PACKAGED_KNOWLEDGE_ID = 'kn-packaged'
const PACKAGED_KNOWLEDGE_TEXT = '打包态 fixture：项目知识写在 YAN_DIR 里，不碰安装目录'
let knowledgeFixture = null
try {
  const { pathToFileURL } = await import('node:url')
  const ids = await import(pathToFileURL(join(root, 'src', 'main', 'project-id.ts')).href)
  const memory = await import(pathToFileURL(join(root, 'src', 'shared', 'project-memory.ts')).href)
  const projectId = ids.legacyProjectId(root)
  const now = new Date().toISOString()
  const entry = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    id: PACKAGED_KNOWLEDGE_ID,
    projectId,
    revision: 1,
    kind: 'fact',
    status: 'active',
    text: PACKAGED_KNOWLEDGE_TEXT,
    textDigest: memory.textDigest(PACKAGED_KNOWLEDGE_TEXT),
    tags: [],
    evidence: [{ sessionId: 'fixture' }],
    confidenceClass: 'user-confirmed',
    createdAt: now,
    updatedAt: now
  }
  const dir = join(dirs.YAN_DATA_DIR, 'project-knowledge', projectId)
  mkdirSync(join(dir, 'entries', entry.id), { recursive: true })
  writeFileSync(join(dir, 'entries', entry.id, 'r1.json'), JSON.stringify(entry, null, 2), 'utf8')
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
        projectId,
        revision: 1,
        updatedAt: now,
        entries: [memory.pointerOf(entry)]
      },
      null,
      2
    ),
    'utf8'
  )
  knowledgeFixture = { projectId, id: entry.id }
  console.log(C.dim(`  项目知识 fixture：${projectId.slice(0, 18)}…/${entry.id}`))
} catch (error) {
  fail('项目知识 fixture 没种下去（探针会红）', error instanceof Error ? error.message : String(error))
}

/* 3. 跑探针
   结果优先从 **文件** 读（YAN_PROBE_OUT），stdout 只当兜底：
   electron-builder 的 portable 单文件版外层包装不转发子进程 stdout，
   而且 Windows GUI 应用本来就不保证有可用控制台。 */
const delay = 9000
const outFile = join(sandbox, 'probe.txt')

/*
 * 子进程环境：先把「从砚自己的 pi 子进程里跑测试」时继承下来的两个东西剥掉。
 *
 *   · ELECTRON_RUN_AS_NODE —— 给「用 Electron 自带 Node 跑 pi」用的
 *     （见 src/main/protocol.ts），但**不能传给 GUI 进程**：从应用内嵌终端
 *     （或任何带这个变量的 shell）跑验收时，它会让 砚.exe 退化成纯 Node ——
 *     无窗口、无 userData、静默 exit 0，看起来完全像「打包后启动失败」。
 *   · YAN_CLI_* / YAN_SESSION_ID / YAN_PROJECT_ID —— **外层那个实例**的能力
 *     服务地址与身份。pi 子进程的环境本来由主进程覆盖，但能力服务没起来时
 *     就是「没有覆盖”，那时继承值会让子进程里的 `yan` 打到真实用户数据目录。
 *     这个坑本轮真撞到过（随手跑 `yan tasks apply` 往真实 `~/.pi` 写了一个操作回执）。
 *
 * 同样的处理见 scripts/review-ui.mjs / scripts/launch.mjs。
 */
const INHERITED_KEYS = ['ELECTRON_RUN_AS_NODE', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']
const cleanEnv = (extra = {}) => {
  const env = { ...process.env }
  for (const k of INHERITED_KEYS) delete env[k]
  /* extra 里显式给的值要保留（例如拿 ELECTRON_RUN_AS_NODE 跑纯 Node 模式） */
  return { ...env, ...extra }
}

const probeEnv = cleanEnv({
  ...dirs,
  YAN_PROBE: join(root, 'scripts', 'probe', 'packaged.js'),
  YAN_PROBE_DELAY: String(delay),
  YAN_PROBE_OUT: outFile
})
const child = spawn(exePath, [
  /*
   * portable wrapper 在某些版本不会把测试环境完整传给解压后的 GUI 子进程。
   * 参数是同一探针的显式兜底；生产启动不带这些参数，也不会改变生产数据路径。
   */
  `--yan-probe=${join(root, 'scripts', 'probe', 'packaged.js')}`,
  `--yan-probe-delay=${delay}`,
  `--yan-probe-out=${outFile}`,
  /* Electron 的内置开关同时隔离单实例锁；其余目录由 paths.ts 读取。 */
  `--user-data-dir=${dirs.YAN_USER_DATA}`,
  `--yan-user-data=${dirs.YAN_USER_DATA}`,
  `--yan-sessions-dir=${dirs.YAN_SESSIONS_DIR}`,
  `--yan-data-dir=${dirs.YAN_DATA_DIR}`,
  `--yan-pi-dir=${dirs.YAN_PI_DIR}`
], {
  cwd: root,
  env: probeEnv,
  windowsHide: true
})

let buf = ''
child.stdout.on('data', (d) => (buf += d))
child.stderr.on('data', (d) => (buf += d))

/*
 * 实例已经跑起来之后再探一次默认远程端口（实施-08 包验收：「服务默认关闭」）。
 * 为什么必须等实例活着：启动前端口本来就没监听，那种探测什么都证明不了。
 * 判据是「连不上」——连接被拒 / 超时都算未监听；真连上了反而是回归。
 */
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

child.kill()
terminatePackagedProcesses(sandbox)
await sleep(600)

/*
 * 4. 随包 `yan` 在**运行时**真的可用（实施-02 S5）。
 *
 * 为什么不能只靠上面的静态存在性：模型敲的是 `yan`（PATH 里的启动器），
 * 而启动器是应用每次启动时才写进 `YAN_DIR/bin/` 的。两件事会各自出错：
 *   · 启动器没生成 → 模型报「命令找不到」；
 *   · 启动了但指向**开发态仓库**里的 yan.mjs → 换一台机器就没有那个路径。
 * 所以这里既看文件在不在，也看内容指向哪里。
 */
const runChecks = []
if (!exeFromArg) {
  const binDir = join(dirs.YAN_DATA_DIR, 'bin')
  const cmdPath = join(binDir, 'yan.cmd')
  const shPath = join(binDir, 'yan')
  runChecks.push([existsSync(cmdPath), `启动器已生成（${cmdPath}）`])
  runChecks.push([existsSync(shPath), `POSIX 启动器已生成（${shPath}）`])
  if (existsSync(cmdPath)) {
    const txt = readFileSync(cmdPath, 'utf8')
    const cliInUnpacked = join(unpacked, 'resources', 'yan-cli', 'yan.mjs')
    runChecks.push([txt.includes(cliInUnpacked), '启动器指向解包目录里的 yan.mjs（不是开发态仓库路径）'])
    runChecks.push([/ELECTRON_RUN_AS_NODE/.test(txt), '启动器用应用自带运行时（ELECTRON_RUN_AS_NODE=1）'])
  }
  if (existsSync(cmdPath) && body != null) {
    /* 内容里用反斜杠分隔，与写入时一致；路径比较做一次归一化 */
    const norm = (s) => s.replace(/[\\/]+/g, '\\')
    runChecks.push([
      norm(readFileSync(cmdPath, 'utf8')).includes(norm(join(unpacked, 'resources', 'yan-cli', 'yan.mjs'))),
      '启动器里的 CLI 路径与安装目录逐段一致'
    ])
  }
}

/*
 * 4a. 包内 git 写操作真的落到了仓库（实施-07 包验收）。
 *
 * 这一条必须由 Node 侧跑：探针里 `git.action` 返回 `ok` 只能说明主进程说成了，
 * 到底有没有真的改到 index，只有重新跑一遍 `git status --porcelain` 才知道 ——
 * `M ` （M 在第一列、第二列空白）= 改动已进暂存区。
 *
 * 只读那半（审查面板的 snapshot / patch / content）在探针里断言，它的改动数量
 * 基准在 2a 由 Node 侧算好（`gitNumstat`）—— 两边合起来才是完整的一件事。
 */
{
  const porcelain = gitRun(['status', '--porcelain']).stdout.trim()
  runChecks.push([
    /^M {2}tracked\.txt$/m.test(porcelain),
    `包内 stage 真的写进了 index（git status → ${JSON.stringify(porcelain)}）`
  ])
}

/*
 * 4b. 交接模块真的进了包（实施-05 S6）。
 *
 * `app.asar` 是归档，但内容是明文的（主进程 bundle + 资源）。
 * 为何在这里做而不在探针里：这些都是**主进程**的常量与文件名，渲染端看不到；
 * 而「打包后少了交接代码」的症状是运行时静默不交接，没有报错可查 ——
 * 只能在包里找证据。
 */
if (!exeFromArg) {
  const asarPath = join(unpacked, 'resources', 'app.asar')
  if (existsSync(asarPath)) {
    const asar = readFileSync(asarPath)
    for (const [needle, label] of [
      ['yan-handoff-resume', '续接标记（shared/handoff-resume）'],
      ['handoff-transactions.json', '交接事务日志文件名'],
      ['session-chains.json', '会话链文件名'],
      ['resumeAttempts', '防盲发两遍的尝试计数'],
      /* 下面几条是各主题的「应用与包」栏（实施-09 S4）：它们验证的是
         「功能代码真的进了包」，而不是「开发态能跑」。 */
      ['context-state', '派生状态目录名（实施-06）'],
      ['src-websearch', '来源菜单里的搜索入口（实施-07 S4）'],
      ['worktree-links.json', '工作树来源关系表（实施-07 S2a）'],
      ['/remote/v1/health', '远程管理路由（实施-08 第一阶段）']
    ]) {
      runChecks.push([asar.includes(needle), `包内含 ${label}（${needle}）`])
    }
  } else {
    runChecks.push([false, 'app.asar 存在（静态索引检查的前提）'])
  }
}

/*
 * 4c. 远程管理服务在解包产物里**默认不监听**（实施-08 包验收 / §2 安全边界第一条）。
 *
 * 这条不能用「读代码看到 `YAN_REMOTE_ENABLE` 判断」代替：真正的风险是打包后的
 * 启动路径上有人无条件调了 `startRemoteServer()`，而那在开发态与包内可能不同。
 * token **不落盘**那一半由协议单测覆盖（test-remote），这里只验「默认关着」。
 */
{
  const probe = await remoteProbe
  runChecks.push([
    probe.reachable === false,
    `远程服务默认不监听（127.0.0.1:${remoteDefaultPort} 连不上：${probe.why ?? 'ok'}）`
  ])
}

/*
 * 4d. 远程服务**显式开启后可启动**（实施-08 包验收的另一半）。
 *
 * 为何要真起第二个实例：默认关闭 + 代码在包里不能推出「打开它就能用」——
 * 打包后可能踩的是另一类坑（环境变量没透传、端口被占、单实例锁）。
 * 单实例锁按 **userData** 分，所以第二个实例用一套独立目录（否则它会被锁挡住）。
 */
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
  const remoteChild = spawn(exePath, [], {
    cwd: root,
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
  for (let i = 0; i < 30 && health !== 200; i += 1) {
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

/*
 * 5. 解包里的 `yan.mjs` 真能跑（`--help` 不需要宿主服务）。
 * 上一轮就是这一类「只验文件存在、不真跑程序」的洞漏掉了一个语法错（见证据-02-S4 §2）。
 */
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
    /* 知识子命令也必须在包里可发现（实施-03 S4/S6） */
    runChecks.push([/knowledge search/.test(out), '用法里含项目知识检索'])
    /*
     * MCP 子命令同样要在包里可发现 + 能跑（实施-04 S3）。
     *
     * 为什么这条属于「应用与包」而不是重复验证：MCP SDK 是本项目**第一个**
     * 被 main 侧引用的 `dependencies`，而 electron-builder.yml 里有
     * `!node_modules/**`。当时的选择是把它 bundle 进 `out/main`（见 electron.vite.config.ts 注释），
     * 所以「打包后还能不能用」必须真跑一次才能下结论 —— 而主进程能启动只是
     * **间接**证据（SDK 加载失败会让它直接起不来）。
     */
    runChecks.push([/mcp describe/.test(out), '用法里含 MCP describe（模型能从 help 里发现它）'])
    const rMcp = spawnSync(exePath, [cliPath, 'mcp', 'describe', '--server', 'x', '--tool', 'y'], {
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    const outMcp = `${rMcp.stdout ?? ''}${rMcp.stderr ?? ''}`
    /* 参数给齐（让校验先过），才测得到「连不上宿主」那一段。 */
    runChecks.push([rMcp.status === 3, `无宿主环境下 mcp describe 报宿主不可用（退出码 ${rMcp.status}）`])
    runChecks.push([/宿主能力服务不可用/.test(outMcp), 'mcp 在无宿主时报可读原因（不是堆栈）'])
    runChecks.push([!/\n\s+at\s+\S/.test(outMcp), 'mcp 无宿主时不吐 Node 堆栈'])

    /*
     * 再跑一次**子命令**（不花 token、也不需要宿主在跑）：
     * 目的是验证参数真的被解析、且缺失宿主环境时给的是**可读原因**而不是崩掉。
     * 模型在打包态最可能撞到的就是这条 —— 它得能从错误里看出是环境不对，
     * 而不是去猜自己的命令写错了。
     */
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

/*
 * 6. 解包实例的读写隔离 + 旧用户数据完整性（实施-03 S6）。
 *
 * 为什么必须在打包态再验一次：开发态读的是仓库里的 `resources/`，而便携版
 * 的私有数据必须全部落在 `YAN_DIR`（便携版 = EXE 旁边的「砚数据」）——
 * 写错位置的症状是「安装目录 / 临时解压目录里多了用户数据」，
 * 而开发态全绿也复现不了（与开头那条 pi 路径的理由相同）。
 */
{
  const knRoot = join(dirs.YAN_DATA_DIR, 'project-knowledge')
  const manifest = knowledgeFixture ? join(knRoot, knowledgeFixture.projectId, 'manifest.json') : ''
  const inSandbox = Boolean(manifest) && existsSync(manifest)
  runChecks.push([inSandbox, '项目知识写在隔离的 YAN_DIR 下（不是安装目录）'])
  if (inSandbox) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      const ids = (parsed.entries ?? []).map((entry) => entry.id)
      runChecks.push([ids.includes(PACKAGED_KNOWLEDGE_ID), `fixture 条目仍在（${ids.join(', ') || '（空）'}）`])
    } catch (error) {
      runChecks.push([false, '读回项目知识 manifest 失败：' + (error instanceof Error ? error.message : String(error))])
    }
  }
  runChecks.push([!existsSync(join(unpacked, 'project-knowledge')), '安装目录里没有被写进 project-knowledge'])
  runChecks.push([!existsSync(join(root, 'project-knowledge')), '开发仓库根目录里没有被写进 project-knowledge'])
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
