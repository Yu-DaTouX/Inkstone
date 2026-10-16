#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  cpSync,
  statSync
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { randomUUID } from 'node:crypto'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { comparePiVersions, requirePiUpgrade } from './lib/pi-upgrade-policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = join(root, 'resources', 'pi-runtime')
let DEST = selectedPiRuntime(runtimeRoot)
const PKG = '@earendil-works/pi-coding-agent'

const MUST_HAVE = [
  'typebox',
  'undici',
  '@silvia-odwyer/photon-node',
  'jiti'
]

const OPTIONAL = ['@aws-sdk/signature-v4-crt', '@aws-sdk/signature-v4a', 'kerberos']

const log = (s) => console.log(s)
const ok = (s) => console.log(`  ✓ ${s}`)
const bad = (s) => console.error(`  ✗ ${s}`)

function findPiRoot() {
  const tried = []
  const push = (p) => {
    if (!p) return null
    tried.push(p)
    return existsSync(join(p, 'dist', 'bundle', 'cli.js')) ? p : null
  }

  if (process.env.YAN_PI_SRC) {
    const hit = push(process.env.YAN_PI_SRC)
    if (hit) return { root: hit, tried }
    throw new Error(`YAN_PI_SRC 指向的目录里没有 dist/bundle/cli.js：${process.env.YAN_PI_SRC}`)
  }

  const roots = []
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  roots.push('/usr/local/lib/node_modules')
  roots.push('/usr/lib/node_modules')
  roots.push(join(root, 'node_modules'))

  for (const r of roots) {
    const hit = push(join(r, PKG))
    if (hit) return { root: hit, tried }
  }

  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const rel of [
      join('node_modules', PKG),
      join('..', 'lib', 'node_modules', PKG),
      join('..', 'node_modules', PKG)
    ]) {
      const hit = push(join(dir, rel))
      if (hit) return { root: hit, tried }
    }
  }

  throw new Error(
    '找不到已安装的 pi。先装一个（npm i -g @earendil-works/pi-coding-agent），\n' +
      '或用 YAN_PI_SRC 指到它的包目录。已尝试的路径：\n  ' + tried.join('\n  ')
  )
}

function depClosure(piRoot, seeds) {
  const have = new Set()
  const missing = []
  const queue = [...seeds]

  const locate = (name) => {
    for (const base of [join(piRoot, 'node_modules'), join(root, 'node_modules')]) {
      const p = join(base, name)
      if (existsSync(join(p, 'package.json'))) return p
    }
    return null
  }

  while (queue.length) {
    const name = queue.shift()
    if (have.has(name) || OPTIONAL.includes(name)) continue
    const dir = locate(name)
    if (!dir) {
      missing.push(name)
      continue
    }
    have.add(name)
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      for (const dep of Object.keys(pj.dependencies || {})) queue.push(dep)
    } catch {
    }
  }
  return { have, missing, locate }
}

function scanExternals(bundleDir) {
  const builtin = new Set(builtinModules)
  const found = new Set()
  const files = []
  ;(function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.js')) files.push(p)
    }
  })(bundleDir)

  for (const f of files) {
    const s = readFileSync(f, 'utf8')
    const consider = (spec) => {
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return
      if (builtin.has(spec)) return
      if (!/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/i.test(spec)) return
      found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
    for (const m of s.matchAll(/import\s*(?:\{[^}]*\}|\*\s*as\s*\w+|\w+)?\s*from\s*["']([^"']+)["']/g))
      consider(m[1])
    for (const m of s.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) consider(m[1])
    for (const m of s.matchAll(/(?:^|[^\w$.])require\s*\(\s*["']([^"']+)["']\s*\)/g)) consider(m[1])
  }
  return found
}

function copyDist(piRoot) {
  const src = join(piRoot, 'dist')
  const dst = join(DEST, 'dist')
  let bytes = 0
  let files = 0

  const keep = (rel) => {
    if (rel.includes(`${'bundle'}`)) return true
    if (rel.endsWith('.map')) return false
    if (rel.endsWith('.d.ts') || rel.endsWith('.ts')) return false
    if (rel.endsWith('.js')) return false
    return true
  }

  ;(function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const from = join(dir, e.name)
      const rel = relative(src, from)
      if (e.isDirectory()) {
        walk(from)
        continue
      }
      if (!keep(rel)) continue
      const to = join(dst, rel)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      bytes += statSync(to).size
      files++
    }
  })(src)

  return { bytes, files }
}

function dirSize(dir) {
  let total = 0
  ;(function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else total += statSync(p).size
    }
  })(dir)
  return total
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB'

function verify(label) {
  const cli = join(DEST, 'dist', 'bundle', 'cli.js')
  const testDir = mkdtempSync(join(tmpdir(), 'inkstone-runtime-check-'))
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: testDir, PI_OFFLINE: '1' }

  let version
  try {
    version = execFileSync(process.execPath, [cli, '--version'], {
      encoding: 'utf8',
      timeout: 60000,
      env,
      windowsHide: true
    }).trim()
    ok(`${label} cli.js --version → ${version}`)
  } catch (e) {
    bad(`${label} cli.js --version 失败：${e.message}`)
    return false
  }

  if (comparePiVersions(version, '0.99.0') >= 0 && !existsSync(join(DEST, 'node_modules', 'quickjs-wasi', 'quickjs.wasm'))) {
    bad(`${label} codemode WASM 缺失：quickjs-wasi/quickjs.wasm`)
    return false
  }
  if (comparePiVersions(version, '0.99.0') >= 0 && !existsSync(join(DEST, 'dist', 'bundle', 'chunks', 'codemode-worker.js'))) {
    bad(`${label} codemode 脚本 worker 缺失`)
    return false
  }

  try {
    const out = execFileSync(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates'], {
      input: '{"id":1,"type":"get_state"}\n',
      encoding: 'utf8',
      timeout: 60000,
      env,
      cwd: testDir,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    const line = out.split('\n').find((l) => l.includes('"type":"response"'))
    if (!line) throw new Error('没有收到 response 帧')
    const frame = JSON.parse(line)
    if (!frame.success) throw new Error('get_state 返回 success:false')
    ok(`${label} RPC 握手 → model=${frame.data?.model?.id ?? '?'}`)
  } catch (e) {
    bad(`${label} RPC 握手失败：${e.message}`)
    return false
  }
  return true
}

const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  if (!existsSync(DEST)) {
    if (process.argv.includes('--if-present')) {
      log('⚠ 跳过内置运行时校验：resources/pi-runtime 不存在（需要时跑 node scripts/vendor-pi.mjs）')
      process.exit(0)
    }
    bad('resources/pi-runtime 不存在，先跑 node scripts/vendor-pi.mjs')
    process.exit(1)
  }
  log(`校验内置运行时 ${relative(root, DEST)}（${mb(dirSize(DEST))}）\n`)
  const usable = verify('内置 pi：')
  if (!usable) {
    log('')
    log('内置运行时自检失败。修复：')
    log('  npm i -g @earendil-works/pi-coding-agent@latest   # 更新源 pi')
    log('  npm run upgrade:pi -- --force                     # 重新提取 + 自检')
  }
  process.exit(usable ? 0 : 1)
}

log('抽取 pi 运行时 → resources/pi-runtime/\n')

const { root: piRoot } = findPiRoot()
const piPackage = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8'))
const piVersion = piPackage.version
const installedVersion = existsSync(join(DEST, 'package.json')) ? JSON.parse(readFileSync(join(DEST, 'package.json'), 'utf8')).version : undefined
try { requirePiUpgrade(installedVersion, piVersion, process.argv.includes('--allow-downgrade')) } catch (error) {
  bad(error.message)
  process.exit(1)
}
if (piPackage.dependencies?.['quickjs-wasi']) {
  MUST_HAVE.push('quickjs-wasi')
}
if (piPackage.dependencies?.['@earendil-works/chord']) {
  MUST_HAVE.push('@earendil-works/chord')
}
ok(`源：${piRoot}`)
ok(`版本：pi ${piVersion}`)

const externals = scanExternals(join(piRoot, 'dist', 'bundle'))
const uncovered = [...externals].filter(
  (e) => !MUST_HAVE.includes(e) && !OPTIONAL.includes(e) && !e.startsWith('@earendil-works/pi-')
)
if (uncovered.length) {
  bad(`bundle 引用了未覆盖的包：${uncovered.join(', ')}`)
  bad('请把它们加进本脚本的 MUST_HAVE（pi 升级后新增依赖时会触发）')
  process.exit(1)
}
ok(`bundle 外部依赖扫描：${externals.size} 个，已全部覆盖`)

const { have, missing, locate } = depClosure(piRoot, MUST_HAVE)
if (missing.length) {
  bad(`依赖闭包不完整，pi 自己的 node_modules 里找不到：${missing.join(', ')}`)
  process.exit(1)
}

const generation = `versions/${piVersion}-${randomUUID()}`
DEST = join(runtimeRoot, generation)
mkdirSync(DEST, { recursive: true })

const dist = copyDist(piRoot)
ok(`dist（bundle + 资产）：${dist.files} 个文件，${mb(dist.bytes)}`)

for (const name of [...have].sort()) {
  const from = locate(name)
  const to = join(DEST, 'node_modules', name)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}
ok(`node_modules 子集：${have.size} 个包`)

writeFileSync(
  join(DEST, 'package.json'),
  JSON.stringify(
    { name: 'pi-runtime-vendored', version: piVersion, type: 'module', private: true },
    null,
    2
  ) + '\n'
)

const total = dirSize(DEST)
log(`\n总计：${mb(total)}  →  ${relative(root, DEST)}`)
log('明细：')
for (const part of ['dist', 'node_modules']) {
  log(`  ${part.padEnd(14)} ${mb(dirSize(join(DEST, part)))}`)
}

log('\n自检（真跑一次 pi）：')
if (!verify('内置 pi：')) {
  bad('内置运行时不可用 —— 不要提交，先修依赖闭包')
  log('  修复入口：npm i -g @earendil-works/pi-coding-agent@latest 后重跑本脚本，')
  log('  或先看 npm run upgrade:pi -- --check 报告的版本差异。')
  process.exit(1)
}

const nextManifest = join(runtimeRoot, `current-${randomUUID()}.json`)
writeFileSync(nextManifest, JSON.stringify({ generation, version: piVersion }, null, 2) + '\n')
renameSync(nextManifest, join(runtimeRoot, 'current.json'))
log('\n完成。新进程使用已验证的运行时；旧运行时保留给正在运行的进程。')
