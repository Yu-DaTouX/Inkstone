#!/usr/bin/env node
/**
 * 升级读取验证（RELEASING 发布门槛第 4 条）。
 *
 * 做法：把 `release/砚数据/`（**真实用户数据，只读**）整份复制到临时目录，
 * 用**打包产物**起一个实例指向这份副本，读回设置 / 项目 / localStorage / 凭证，
 * 再逐字节确认**原目录没被碰过**。
 *
 * 为什么必须用副本而不是原目录：原目录是用户真实数据，任何一次跑动写进去都
 * 不可接受（RELEASING：`release/砚数据/` 只读，升级验证只用备份副本）。
 *
 * 用法：
 *   npm run dist:dir         先产出 release/win-unpacked
 *   npm run test:upgrade     跑本脚本（不烧 token；只起一个实例读状态）
 *
 * 判据：
 *   · 副本里 `yan/desktop.json` 的 cwd / lang / theme / projects 与实例读回的一致；
 *   · `profile.signedIn === false`（**不伪造登录**）；
 *   · `pi-agent/auth.json` 存在且 count ≥ 1，且 `conn = ready`（凭证真的能用）；
 *   · localStorage 里的 theme / onboarded 还在（升级不把界面状态清空）；
 *   · 跑完后原目录逐字节未变（用文件清单 + sha256 比对）。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = join(root, 'release', 'win-unpacked')
const source = join(root, 'release', '砚数据')

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`
}
let failed = 0
const say = (good, text, extra = '') => {
  console.log(`${good ? C.ok('  ✓') : C.err('  ✗')} ${text}${extra ? '  ' + C.dim(extra) : ''}`)
  if (!good) failed += 1
}

if (process.platform !== 'win32') {
  console.error('这个脚本目前只支持 Windows（先做 Windows 分发）')
  process.exit(1)
}
if (!existsSync(unpacked)) {
  console.error('找不到 release/win-unpacked —— 先跑 npm run dist:dir')
  process.exit(1)
}
if (!existsSync(source)) {
  console.error(`找不到 ${source}（真实用户数据）。没有它就无法做升级验证 —— 不伪造。`)
  process.exit(1)
}

/* ---- 1. 复制副本（原目录只读） ---- */
const copy = mkdtempSync(join(tmpdir(), 'yan-upgrade-'))
cpSync(source, copy, { recursive: true })
console.log(`  副本：${copy}`)

/** 目录树指纹：相对路径 + 大小 + sha256（用来证明原目录没被动过） */
function fingerprint(dir) {
  const rows = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else {
        rows.push(`${relative(dir, full).replace(/\\/g, '/')}  ${st.size}  ${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(dir)
  return rows.sort()
}

const before = fingerprint(source)

/* ---- 2. 副本里的期望值（Node 侧才知道原本写的是什么） ---- */
let expected = null
try {
  const desktop = JSON.parse(readFileSync(join(copy, 'yan', 'desktop.json'), 'utf8'))
  expected = {
    cwd: desktop.cwd ?? null,
    lang: desktop.lang ?? null,
    theme: desktop.theme ?? null,
    projects: Array.isArray(desktop.projects) ? desktop.projects.length : null,
    signedIn: desktop.profile?.signedIn === true
  }
  console.log(`  副本 desktop.json：${JSON.stringify(expected)}`)
} catch (error) {
  console.error(`  读不出副本里的 desktop.json：${error.message}`)
  process.exit(1)
}

/* ---- 3. 用打包产物起实例（只读副本） ---- */
const outFile = join(copy, 'probe-out.txt')
const delay = 9000
/* 外层实例注入的那些变量必须**删掉**（设为 undefined 不保险）：否则副本里那个
   实例的 `yan` 会打到外层真实实例，写真实用户数据。 */
const probeEnv = {
  ...process.env,
  YAN_USER_DATA: join(copy, 'electron'),
  YAN_PI_DIR: join(copy, 'pi-agent'),
  YAN_SESSIONS_DIR: join(copy, 'pi-agent', 'sessions'),
  YAN_DATA_DIR: join(copy, 'yan'),
  YAN_PROBE: join(root, 'scripts', 'probe', 'upgrade-read.js'),
  YAN_PROBE_DELAY: String(delay),
  YAN_PROBE_OUT: outFile
}
for (const k of ['ELECTRON_RUN_AS_NODE', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) {
  delete probeEnv[k]
}
const child = spawn(join(unpacked, '砚.exe'), [], {
  cwd: root,
  windowsHide: true,
  env: probeEnv
})
let buf = ''
child.stdout.on('data', (d) => (buf += d))
child.stderr.on('data', (d) => (buf += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + delay + 120_000
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
await sleep(800)

if (!body) {
  console.error(C.err('✗ 没拿到探针输出'), buf.slice(-800))
  process.exit(1)
}
const line = body.split('\n').find((l) => l.startsWith('UPGRADE-READ '))
if (!line) {
  console.error(C.err('✗ 探针输出里没有 UPGRADE-READ 行'), body.slice(-800))
  process.exit(1)
}
const got = JSON.parse(line.slice('UPGRADE-READ '.length))
console.log(`  实例读回：${JSON.stringify(got)}`)

/* ---- 4. 断言 ---- */
say(got.conn === 'ready', '打包实例连上了内置 pi（凭证可用）', String(got.conn))
say(got.pi?.bundled === true, 'pi 入口来自包内运行时', String(got.pi?.version ?? ''))
say(got.settings?.cwd === expected.cwd, `读回 cwd 与副本一致`, `${got.settings?.cwd} / ${expected.cwd}`)
say(got.settings?.lang === expected.lang, '读回 lang 与副本一致', `${got.settings?.lang} / ${expected.lang}`)
say(got.settings?.theme === expected.theme, '读回 theme 与副本一致', `${got.settings?.theme} / ${expected.theme}`)
say(
  got.settings?.projects === expected.projects,
  '项目清单条数一致（升级后项目没丢）',
  `${got.settings?.projects} / ${expected.projects}`
)
say(got.settings?.profile?.signedIn === false, '登录态如实为未登录（**不伪造**）', String(got.settings?.profile?.signedIn))
say(got.auth?.exists === true && got.auth?.count >= 1, '凭证文件存在且能读（auth count ≥ 1）', JSON.stringify(got.auth))
say(!!got.local?.theme, 'localStorage 里的主题还在（界面状态没被清空）', String(got.local?.theme))
say(got.local?.onboarded === '1', 'localStorage 里的引导标记还在', String(got.local?.onboarded))

/* ---- 5. 原目录逐字节未变 ---- */
const after = fingerprint(source)
const same = before.length === after.length && before.every((row, i) => row === after[i])
say(same, `原目录 release/砚数据 逐字节未变（${before.length} 个文件）`)

console.log('')
if (failed === 0) {
  console.log(C.ok('✓ 升级读取验证通过'))
  process.exit(0)
}
console.error(C.err(`✗ 升级读取验证失败（${failed} 条）`))
process.exit(1)
