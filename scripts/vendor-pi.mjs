#!/usr/bin/env node
/**
 * 把已安装的 pi 抽成一个**可独立运行**的运行时 → resources/pi-runtime/
 *
 * 为什么这么做（HANDOFF §10 问题 1「pi 怎么分发」）
 * ---------------------------------------------------------------
 * 不要自己做 esbuild 单文件。pi **自己就是 esbuild 打的**（dist/bundle/），
 * 而它打成这样是有原因的 —— 以下四类东西打包器内联不了：
 *   ① 顶层 external 包（chord / typebox / undici）→ ESM 顶层 import 只能留 external
 *   ② .wasm（@silvia-odwyer/photon-node）→ esbuild 不内联 wasm
 *   ③ worker_threads 的独立文件（image-resize-worker.js）
 *   ④ 运行时 readFileSync 的资产（主题 json / export-html 模板 / png）
 * 官方自己的 bundle 撞了这四堵墙，我们照着它的边界「原样搬运 + 补最小依赖」，
 * 而不是重新发明一个必然更脆的打包。
 *
 * 实测体积 ≈ 21MB（依赖捆绑方案 424MB，差距 20 倍）。
 *
 * 用法：
 *   node scripts/vendor-pi.mjs            # 有则覆盖
 *   node scripts/vendor-pi.mjs --check    # 只校验现有 runtime 是否可用，不重建
 *   YAN_PI_SRC=<pi包目录> node scripts/vendor-pi.mjs
 *
 * 脚本末尾会**真跑一次** `cli.js --version` + 一次 `get_state` RPC 握手，
 * 失败就非零退出 —— 不做「拷贝成功即通过」这种假验证。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  cpSync,
  statSync
} from 'node:fs'
import { join, dirname, delimiter, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(root, 'resources', 'pi-runtime')
const PKG = '@earendil-works/pi-coding-agent'

/**
 * 需要随 bundle 一起带的运行时依赖。
 *
 * source: 'bundle' = 从 bundle 的裸 import 自动扫出来的（脚本会校验，
 *         扫出来却没覆盖到就报错，避免 pi 升级后漏包）
 *         'runtime' = bundle 里扫不到、只有运行到某个分支才会 require 的
 */
const MUST_HAVE = [
  // bundle 里 import 出来的
  '@earendil-works/chord',
  'typebox',
  'undici',
  '@silvia-odwyer/photon-node',
  // 加载 .ts 扩展（我们的 yan-memory.ts）用的编译器。
  // ⚠️ bundle 里静态扫不到它 —— 是扩展加载器在运行时 require 的（HANDOFF §8 第 11 版坑）
  'jiti'
]

/** 已知「可以缺失」的：可选依赖，pi 自己也没装，缺失时功能降级而非崩溃 */
const OPTIONAL = ['@aws-sdk/signature-v4-crt', '@aws-sdk/signature-v4a']

const log = (s) => console.log(s)
const ok = (s) => console.log(`  ✓ ${s}`)
const bad = (s) => console.error(`  ✗ ${s}`)

/* ------------------------------------------------------------------
   1. 找到已安装的 pi
   ------------------------------------------------------------------ */
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
  // 当前项目自己的 node_modules（万一以后 pi 变成 npm 依赖）
  roots.push(join(root, 'node_modules'))

  for (const r of roots) {
    const hit = push(join(r, PKG))
    if (hit) return { root: hit, tried }
  }

  // 从 PATH 上的 pi shim 反推
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

/* ------------------------------------------------------------------
   2. 依赖闭包（递归读 package.json 的 dependencies）
   ------------------------------------------------------------------ */
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
      /* package.json 坏了也不致命，pi 运行时自然会报 */
    }
  }
  return { have, missing, locate }
}

/* ------------------------------------------------------------------
   3. 扫 bundle 的裸 import —— 用来校验 MUST_HAVE 没漏
   ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
   4. 拷贝 dist（保留资产，丢掉源码与类型声明）
   ------------------------------------------------------------------ */
function copyDist(piRoot) {
  const src = join(piRoot, 'dist')
  const dst = join(DEST, 'dist')
  let bytes = 0
  let files = 0

  const keep = (rel) => {
    if (rel.includes(`${'bundle'}`)) return true // bundle 里的 .js 全要
    if (rel.endsWith('.map')) return false
    if (rel.endsWith('.d.ts') || rel.endsWith('.ts')) return false
    if (rel.endsWith('.js')) return false // 未打包的 TS 产物，bundle 已自包含
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

/* ------------------------------------------------------------------
   5. 自检：真跑一次 RPC 握手
   ------------------------------------------------------------------ */
function verify(label) {
  const cli = join(DEST, 'dist', 'bundle', 'cli.js')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

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

  // 真握手一次：确认依赖闭包完整（缺任何外部包都会在这里暴露）
  try {
    const out = execFileSync(process.execPath, [cli, '--mode', 'rpc', '--no-session'], {
      input: '{"id":1,"type":"get_state"}\n',
      encoding: 'utf8',
      timeout: 60000,
      env,
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

/* ------------------------------------------------------------------
   main
   ------------------------------------------------------------------ */
const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  if (!existsSync(DEST)) {
    bad('resources/pi-runtime 不存在，先跑 node scripts/vendor-pi.mjs')
    process.exit(1)
  }
  log(`校验内置运行时 ${relative(root, DEST)}（${mb(dirSize(DEST))}）\n`)
  process.exit(verify('内置 pi：') ? 0 : 1)
}

log('抽取 pi 运行时 → resources/pi-runtime/\n')

const { root: piRoot } = findPiRoot()
const piVersion = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).version
ok(`源：${piRoot}`)
ok(`版本：pi ${piVersion}`)

// 校验：bundle 扫出来的 external 必须都被 MUST_HAVE 覆盖
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

rmSync(DEST, { recursive: true, force: true })
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

// 最小 package.json：bundle 会读它取版本号
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
  process.exit(1)
}

log('\n完成。应用会优先用这个内置运行时，找不到才回退到全局安装的 pi。')
