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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const dirs = {
  YAN_USER_DATA: join(sandbox, 'userData'),
  YAN_SESSIONS_DIR: join(sandbox, 'sessions'),
  YAN_DATA_DIR: join(sandbox, 'data'),
  YAN_PI_DIR: join(sandbox, 'pi-agent')
}
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
writeFileSync(join(dirs.YAN_DATA_DIR, 'desktop.json'), JSON.stringify({ cwd: root, lang: 'zh-CN' }), 'utf8')
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
const child = spawn(exePath, [], {
  cwd: root,
  env: probeEnv,
  windowsHide: true
})

let buf = ''
child.stdout.on('data', (d) => (buf += d))
child.stderr.on('data', (d) => (buf += d))

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

rmSync(sandbox, { recursive: true, force: true })

if (body == null) {
  console.error(`\n${C.err('✗')} 没拿到 PROBE 输出 —— 打包后的应用可能启动失败`)
  console.error(C.dim(buf.slice(-3000) || '(child 没有任何输出，也没写结果文件)'))
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
  console.error(`\n${C.err('✗ 打包验收失败')}`)
  process.exit(1)
}
console.log(`\n${C.ok('✓ 打包验收通过')} ${C.dim('内置 pi 在安装目录里可用')}`)
