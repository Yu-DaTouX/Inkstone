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
 * 读的是仓库里的 `resources/pi-runtime`。打包后 pi 与记忆扩展都改从
 * `process.resourcesPath/` 找 —— 路径错了应用**能启动但连不上**，
 * 开发态测试全绿也照样复现不了。这个脚本就是专门补那个缝。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/* ------------------------------------------------------------------
   0. 前置：打包产物在不在
   ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
   1. extraResources 必须真的落在安装目录里
   ------------------------------------------------------------------ */
const must = [
  ['pi-runtime', join(unpacked, 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')],
  ['pi-runtime node_modules', join(unpacked, 'resources', 'pi-runtime', 'node_modules')],
  ['记忆扩展', join(unpacked, 'resources', 'pi', 'yan-memory.ts')],
  ['app.asar', join(unpacked, 'resources', 'app.asar')]
]
if (exeFromArg) {
  console.log(C.dim('  （--exe 模式：跳过 win-unpacked 静态检查，只跑探针）'))
} else {
  for (const [label, p] of must) {
    if (!existsSync(p)) fail(`extraResources 缺件：${label}`, p)
  }
  console.log(`  ${C.ok('✓')} extraResources 落位（pi-runtime / pi / app.asar）`)
}

/* ------------------------------------------------------------------
   2. 隔离沙盒（绝不碰真实 sessions / memory / localStorage）
   ------------------------------------------------------------------ */
const sandbox = mkdtempSync(join(tmpdir(), 'yan-packaged-'))
const dirs = {
  YAN_USER_DATA: join(sandbox, 'userData'),
  YAN_SESSIONS_DIR: join(sandbox, 'sessions'),
  YAN_DATA_DIR: join(sandbox, 'data'),
  YAN_PI_DIR: join(sandbox, 'pi-agent')
}
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
writeFileSync(join(dirs.YAN_DATA_DIR, 'desktop.json'), JSON.stringify({ cwd: root }), 'utf8')
console.log(C.dim(`  隔离目录 ${sandbox}`))

/* ------------------------------------------------------------------
   3. 跑探针

   结果优先从 **文件** 读（YAN_PROBE_OUT），stdout 只当兜底：
   electron-builder 的 portable 单文件版外层包装不转发子进程 stdout，
   而且 Windows GUI 应用本来就不保证有可用控制台。
   ------------------------------------------------------------------ */
const delay = 9000
const outFile = join(sandbox, 'probe.txt')
const child = spawn(exePath, [], {
  cwd: root,
  env: {
    ...process.env,
    ...dirs,
    YAN_PROBE: join(root, 'scripts', 'probe', 'packaged.js'),
    YAN_PROBE_DELAY: String(delay),
    YAN_PROBE_OUT: outFile
  },
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
rmSync(sandbox, { recursive: true, force: true })

if (body == null) {
  console.error(`\n${C.err('✗')} 没拿到 PROBE 输出 —— 打包后的应用可能启动失败`)
  console.error(C.dim(buf.slice(-3000) || '(child 没有任何输出，也没写结果文件)'))
  process.exit(1)
}

body = body.trim()
console.log('\n' + body)
if (/✗/.test(body)) {
  console.error(`\n${C.err('✗ 打包验收失败')}`)
  process.exit(1)
}
console.log(`\n${C.ok('✓ 打包验收通过')} ${C.dim('内置 pi + 记忆扩展在安装目录里可用')}`)
