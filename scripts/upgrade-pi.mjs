#!/usr/bin/env node
/**
 * 升级 / 刷新内置 pi 运行时。
 *
 * 为什么单独一个脚本：`vendor-pi.mjs` 只负责「把某个 pi 抽出来」，
 * 但它不回答升级时最关心的两个问题 —— 现在内置的是哪个版本、源上的
 * 又是哪个版本、要不要动。这个脚本补齐这一层：
 *
 *   1. 对比内置版本 vs 源版本
 *   2. 需要时才调 vendor-pi.mjs（真正的提取 + 自检）
 *   3. 自检失败时给出可执行的修复清单，而不是只丢一句「失败」
 *
 * 用法：
 *   npm run upgrade:pi              # 版本不同才提取
 *   npm run upgrade:pi -- --force   # 同版本也重跑提取（怀疑内置运行时损坏时用）
 *   npm run upgrade:pi -- --check   # 只报告版本，不动任何文件
 *   YAN_PI_SRC=<pi包目录> npm run upgrade:pi
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(root, 'resources', 'pi-runtime')
const PKG = '@earendil-works/pi-coding-agent'

const args = process.argv.slice(2)
const force = args.includes('--force')
const checkOnly = args.includes('--check')

const log = (s) => console.log(s)
const bad = (s) => console.error(`  ✗ ${s}`)

/** 读一个 package.json 的 version，坏了返回 undefined */
function readVersion(pkgJsonPath) {
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
  } catch {
    return undefined
  }
}

/** 内置运行时的版本（读它自己的 package.json） */
function bundledVersion() {
  const v = readVersion(join(DEST, 'package.json'))
  return existsSync(join(DEST, 'dist', 'bundle', 'cli.js')) ? v : undefined
}

/**
 * 找「升级来源」的 pi 包根目录。
 *
 * 与 vendor-pi.mjs 的 findPiRoot 保持同一套候选顺序：
 * YAN_PI_SRC → 各全局安装位置 → PATH shim 反推。
 * 这里只用于读版本 / 提示，真正的定位仍以 vendor-pi.mjs 为准。
 */
function findSourceRoot() {
  const candidates = []
  if (process.env.YAN_PI_SRC) candidates.push(process.env.YAN_PI_SRC)
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', PKG))
  candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules', PKG))
  candidates.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  candidates.push(join(root, 'node_modules', PKG))
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, 'node_modules', PKG))
    candidates.push(join(dir, '..', 'lib', 'node_modules', PKG))
    candidates.push(join(dir, '..', 'node_modules', PKG))
  }
  for (const c of candidates) {
    if (existsSync(join(c, 'dist', 'bundle', 'cli.js'))) return c
  }
  return null
}

/** 自检失败时告诉用户到底该做什么 */
function repairHints() {
  log('')
  log('修复清单（按顺序试）：')
  log('  1. 确认源 pi 完整：npm i -g @earendil-works/pi-coding-agent@latest')
  log('  2. 依赖闭包缺包时，在 pi 自己的目录补装：')
  log('     npm i -g @earendil-works/chord typebox undici @silvia-odwyer/photon-node jiti')
  log('  3. 指定一个已知可用的包目录重试：')
  log('     YAN_PI_SRC=<pi包目录> node scripts/vendor-pi.mjs')
  log('  4. 仍失败：把完整输出发出来（vendor-pi 会打印缺失的包名）')
  log('')
  log('注意：内置运行时不可用时不要提交、不要打包 —— 装出来的应用会连不上 pi。')
}

/* ------------------------------------------------------------------ */
const src = findSourceRoot()
const cur = bundledVersion()
const next = src ? readVersion(join(src, 'package.json')) : undefined

log('内置 pi 运行时')
log(`  当前：${cur ?? '（无）'}   ${existsSync(DEST) ? DEST : '(未生成)'}`)
log(`  来源：${next ?? '（未找到源 pi）'}   ${src ?? ''}`)

if (checkOnly) {
  process.exit(0)
}

if (!src) {
  bad('找不到可用的源 pi。先安装，或用 YAN_PI_SRC 指向它的包目录。')
  repairHints()
  process.exit(1)
}

if (!force && cur && next && cur === next) {
  log('\n已是最新，无需提取。（想强制重跑加 --force）')
  process.exit(0)
}

log(`\n提取：${cur ?? '无'} → ${next ?? '?'}\n`)
const res = spawnSync(process.execPath, [join(root, 'scripts', 'vendor-pi.mjs')], {
  stdio: 'inherit',
  env: process.env
})

if (res.status !== 0) {
  bad('提取或自检失败。')
  repairHints()
  process.exit(res.status ?? 1)
}

log('\n升级完成。')
log('内置运行时版本在进程内缓存 —— 请**重启应用**后生效。')
