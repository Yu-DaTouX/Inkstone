#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { requirePiUpgrade } from './lib/pi-upgrade-policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = selectedPiRuntime(join(root, 'resources', 'pi-runtime'))
const PKG = '@earendil-works/pi-coding-agent'

const args = process.argv.slice(2)
const force = args.includes('--force')
const checkOnly = args.includes('--check')
const allowDowngrade = args.includes('--allow-downgrade')

const log = (s) => console.log(s)
const bad = (s) => console.error(`  ✗ ${s}`)

function readVersion(pkgJsonPath) {
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
  } catch {
    return undefined
  }
}

function bundledVersion() {
  const v = readVersion(join(DEST, 'package.json'))
  return existsSync(join(DEST, 'dist', 'bundle', 'cli.js')) ? v : undefined
}

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

function repairHints() {
  log('')
  log('修复清单（按顺序试）：')
  log('  1. 确认源 pi 完整：npm i -g @earendil-works/pi-coding-agent@latest')
  log('  2. 依赖闭包缺包时，在 pi 自己的目录补装：')
  log('     npm i -g typebox undici @silvia-odwyer/photon-node jiti   （pi 1.2.0 之前的版本另需 @earendil-works/chord）')
  log('  3. 指定一个已知可用的包目录重试：')
  log('     YAN_PI_SRC=<pi包目录> node scripts/vendor-pi.mjs')
  log('  4. 仍失败：把完整输出发出来（vendor-pi 会打印缺失的包名）')
  log('')
  log('注意：内置运行时不可用时不要提交、不要打包 —— 装出来的应用会连不上 pi。')
}


const src = findSourceRoot()
const cur = bundledVersion()
const next = src ? readVersion(join(src, 'package.json')) : undefined

log('内置 pi 运行时')
log(`  当前：${cur ?? '（无）'}   ${existsSync(DEST) ? DEST : '(未生成)'}`)
log(`  来源：${next ?? '（未找到源 pi）'}   ${src ?? ''}`)

if (checkOnly) {
  try { requirePiUpgrade(cur, next) } catch (error) { log(`  注意：${error.message}`) }
  process.exit(0)
}

if (!src) {
  bad('找不到可用的源 pi。先安装，或用 YAN_PI_SRC 指向它的包目录。')
  repairHints()
  process.exit(1)
}

try { requirePiUpgrade(cur, next, allowDowngrade) } catch (error) {
  bad(error.message)
  process.exit(1)
}

if (!force && cur && next && cur === next) {
  log('\n已是最新，无需提取。（想强制重跑加 --force）')
  process.exit(0)
}

log(`\n提取：${cur ?? '无'} → ${next ?? '?'}\n`)
const res = spawnSync(process.execPath, [join(root, 'scripts', 'vendor-pi.mjs'), ...(allowDowngrade ? ['--allow-downgrade'] : [])], {
  stdio: 'inherit',
  env: process.env
})

if (res.status !== 0) {
  bad('提取或自检失败。')
  repairHints()
  process.exit(res.status ?? 1)
}

log('\n重新生成模型能力表 …')
const catalog = spawnSync(process.execPath, [join(root, 'scripts', 'gen-pi-model-catalog.mjs')], { stdio: 'inherit', env: process.env })
if (catalog.error || catalog.status !== 0) {
  bad('内置运行时已更新，但模型能力表未完成，升级未全部完成。')
  if (catalog.error) bad(`模型能力表生成进程启动失败：${catalog.error.message}`)
  bad('请补生成：node scripts/gen-pi-model-catalog.mjs，并把结果一起提交。')
  process.exit(catalog.status || 1)
}

log('\n升级完成。')
log('内置运行时版本在进程内缓存 —— 请**重启应用**后生效。')
