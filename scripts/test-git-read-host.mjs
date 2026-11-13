import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'yan-git-read-host-')))
const slash = (path) => path.replace(/\\/g, '/')
let checks = 0
const ok = (condition, label, detail = '') => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label)
  checks++
  console.log(`  ✓ ${label}`)
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'yan-test',
  GIT_AUTHOR_EMAIL: 'yan-test@example.com',
  GIT_COMMITTER_NAME: 'yan-test',
  GIT_COMMITTER_EMAIL: 'yan-test@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
}
const previousEnv = { ...process.env }
Object.assign(process.env, GIT_ENV)

const shim = join(root, 'shim.mjs')
writeFileSync(shim, [
  "import { EventEmitter } from 'node:events'",
  'const port = new EventEmitter()',
  "process.on('message', (data) => port.emit('message', { data }))",
  'port.postMessage = (message) => process.send(message)',
  'process.parentPort = port'
].join('\n'))
const workerEntry = join(root, 'worker-entry.mjs')
writeFileSync(workerEntry, `import ${JSON.stringify(slash(shim))}\nimport ${JSON.stringify(slash(resolve('src/main/git-read-worker.ts')))}\n`)
const hostEntry = join(root, 'host-entry.mjs')
writeFileSync(hostEntry, [
  `export { runGitRead, disposeGitReadHost, gitReadHostEnabled } from ${JSON.stringify(slash(resolve('src/main/git-read-host.ts')))}`,
  `export { runGitReadOp } from ${JSON.stringify(slash(resolve('src/main/git-read-ops.ts')))}`,
  `export { setUiLang } from ${JSON.stringify(slash(resolve('src/shared/ui-lang.ts')))}`
].join('\n'))

await build({ entryPoints: [workerEntry], outfile: join(root, 'git-read-worker.js'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
await build({
  entryPoints: [hostEntry],
  outfile: join(root, 'host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error',
  plugins: [{
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: 'export const utilityProcess = { fork: (...args) => globalThis.__fork(...args) }' }))
    }
  }]
})

class Proc extends EventEmitter {
  constructor(child) {
    super()
    this.child = child
    child.on('message', (message) => this.emit('message', message))
    child.on('exit', (code) => this.emit('exit', code))
  }
  postMessage(message) {
    if (globalThis.__dieOnPost > 0) {
      globalThis.__dieOnPost -= 1
      this.child.kill()
      return
    }
    this.child.send(message)
  }
  kill() {
    return this.child.kill()
  }
}
const forks = []
globalThis.__fork = (path) => {
  if (globalThis.__forkFails) throw new Error('fork failed')
  const proc = new Proc(fork(path, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }))
  forks.push(proc)
  return proc
}

const host = await import(pathToFileURL(join(root, 'host.mjs')).href)

const hook = (name, marker) => {
  const file = join(root, name)
  writeFileSync(file, `#!/bin/sh\necho ran > "${slash(marker)}"\ncat\n`)
  return `sh "${slash(file)}"`
}

const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git('init', '-q', '-b', 'trunk')
mkdirSync(join(repo, 'sub'))
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
writeFileSync(join(repo, 'sub', 'b.txt'), 'bee\n')
writeFileSync(join(repo, 'evil.dat'), 'x\n')
writeFileSync(join(repo, '.gitattributes'), 'evil.dat filter=evil\n')
writeFileSync(join(repo, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
git('add', '.')
git('commit', '-q', '-m', 'first')
const firstSha = git('rev-parse', 'HEAD').trim()
git('tag', 'v1')
git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
git('checkout', '-q', '-b', 'feature')
writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
git('commit', '-q', '-am', 'second')
writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
writeFileSync(join(repo, 'sub', 'b.txt'), 'bee\nstaged\n')
git('add', 'sub/b.txt')
writeFileSync(join(repo, 'sub', 'new.txt'), 'fresh\nfile\n')
writeFileSync(join(repo, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]))
const marker = join(root, 'filter-ran.txt')
git('config', 'filter.evil.clean', hook('filter.sh', marker))
git('config', 'filter.evil.smudge', hook('filter.sh', marker))
git('config', 'filter.evil.required', 'true')
writeFileSync(join(repo, 'evil.dat'), 'y\n')
const later = new Date(Date.now() + 120_000)
utimesSync(join(repo, 'evil.dat'), later, later)
const plain = join(root, 'plain')
mkdirSync(plain)
const missing = join(root, 'missing')

const authCalls = []
const allow = async (cwd) => {
  authCalls.push(cwd)
  return { ok: true, cwd }
}
const deny = async () => ({ ok: false, error: 'denied here' })
const subOnly = async (cwd) => (resolve(cwd) === resolve(repo, 'sub') ? { ok: true, cwd } : { ok: false, error: 'outside' })
const explode = async () => {
  throw new Error('authorize blew up')
}

async function both(request, authorize = allow) {
  const local = await host.runGitReadOp(request, authorize).then((value) => ({ value }), (error) => ({ error: error.message }))
  const remote = await host.runGitRead(request, authorize).then((value) => ({ value }), (error) => ({ error: error.message }))
  return { local, remote }
}

async function same(label, request, authorize) {
  const { local, remote } = await both(request, authorize)
  assert.deepStrictEqual(remote, local, label)
  checks++
  console.log(`  ✓ ${label}`)
  return local
}

try {
  const cases = [
    ['轻量仓库状态', { op: 'state', cwd: repo, light: true }],
    ['完整仓库状态与 expected', { op: 'state', cwd: repo, light: false }],
    ['子目录的仓库状态', { op: 'state', cwd: join(repo, 'sub'), light: true }],
    ['分支与标签列表', { op: 'refs', cwd: repo }],
    ['远程列表', { op: 'remotes', cwd: repo }],
    ['工作区改动带预填补丁', { op: 'changes', cwd: repo, options: { patches: true } }],
    ['工作区改动不带补丁', { op: 'changes', cwd: repo, options: { patches: false } }],
    ['相对基线分支的改动', { op: 'changes', cwd: repo, options: { scope: { kind: 'branch', base: 'trunk' }, patches: true } }],
    ['单个提交的改动', { op: 'changes', cwd: repo, options: { scope: { kind: 'commit', sha: firstSha } } }],
    ['已跟踪文件的 diff 带上下文', { op: 'diff', cwd: repo, path: 'a.txt', options: { contents: true } }],
    ['暂存文件的 diff', { op: 'diff', cwd: repo, path: 'sub/b.txt', options: { contents: true } }],
    ['未跟踪文件的 diff', { op: 'diff', cwd: repo, path: 'sub/new.txt', options: {} }],
    ['图片 diff 带两侧数据', { op: 'diff', cwd: repo, path: 'pic.png', options: { images: true } }],
    ['基线分支范围的 diff', { op: 'diff', cwd: repo, path: 'a.txt', options: { scope: { kind: 'branch', base: 'trunk' }, contents: true } }],
    ['非法路径的 diff', { op: 'diff', cwd: repo, path: '../x', options: {} }],
    ['非法范围的改动', { op: 'changes', cwd: repo, options: { scope: { kind: 'nope' } } }],
    ['找不到的提交', { op: 'changes', cwd: repo, options: { scope: { kind: 'commit', sha: 'deadbeef' } } }],
    ['不是仓库：状态', { op: 'state', cwd: plain, light: true }],
    ['不是仓库：分支', { op: 'refs', cwd: plain }],
    ['不是仓库：远程', { op: 'remotes', cwd: plain }],
    ['不是仓库：改动', { op: 'changes', cwd: plain, options: {} }],
    ['不是仓库：diff', { op: 'diff', cwd: plain, path: 'a.txt', options: {} }],
    ['目录不存在：状态', { op: 'state', cwd: missing, light: false }],
    ['目录不存在：分支', { op: 'refs', cwd: missing }],
    ['目录不存在：改动', { op: 'changes', cwd: missing, options: {} }],
    ['目录不存在：diff', { op: 'diff', cwd: missing, path: 'a.txt', options: {} }]
  ]
  for (const [label, request] of cases) await same(`宿主与主进程逐字段相同：${label}`, request)
  ok(forks.length === 1, '多次查询只启动一个 git 宿主进程', String(forks.length))
  ok(!existsSync(marker), '宿主里的读取同样不执行仓库配置的过滤器')

  const light = await host.runGitRead({ op: 'state', cwd: repo, light: true }, allow)
  ok(light.value === undefined && light.repo?.branch === 'feature' && light.repo.changedCount === 5 && light.expected === undefined, '轻量状态内容正确', JSON.stringify(light.repo))
  const changes = await host.runGitRead({ op: 'changes', cwd: repo, options: {} }, allow)
  ok(changes.ok && changes.files.map((file) => file.path).join(',') === 'a.txt,evil.dat,pic.png,sub/b.txt,sub/new.txt', '改动列表内容正确', JSON.stringify(changes.files.map((file) => file.path)))

  authCalls.length = 0
  await host.runGitRead({ op: 'changes', cwd: join(repo, 'sub'), options: {} }, allow)
  ok(authCalls.length === 2 && resolve(authCalls[0]) === resolve(repo, 'sub') && resolve(authCalls[1]) === resolve(repo), '宿主里的授权检查回到主进程执行，顺序与次数不变', JSON.stringify(authCalls))
  await same('授权被拒：改动', { op: 'changes', cwd: repo, options: {} }, deny)
  await same('授权被拒：diff', { op: 'diff', cwd: repo, path: 'a.txt', options: {} }, deny)
  await same('只授权子目录：改动限定在子目录', { op: 'changes', cwd: join(repo, 'sub'), options: { patches: true } }, subOnly)
  await same('只授权子目录：子目录外的 diff 被拒', { op: 'diff', cwd: join(repo, 'sub'), path: '../a.txt', options: {} }, subOnly)
  const thrown = await same('授权本身抛错时错误原样传回', { op: 'changes', cwd: repo, options: {} }, explode)
  ok(thrown.error === 'authorize blew up', '授权抛错的文字不变', JSON.stringify(thrown))

  host.setUiLang('en-US')
  const english = await same('界面语言随请求带进宿主', { op: 'refs', cwd: plain })
  ok(english.value.error === 'This folder is not in a Git repository', '英文界面下宿主返回英文错误', JSON.stringify(english))
  host.setUiLang('zh-CN')

  const savedPath = process.env.PATH
  const savedWinPath = process.env.Path
  process.env.PATH = join(root, 'no-git-here')
  if (savedWinPath !== undefined) process.env.Path = join(root, 'no-git-here')
  try {
    const gone = await same('git 不存在：状态', { op: 'state', cwd: repo, light: true })
    ok(/没有找到 git/.test(gone.error ?? ''), '主进程运行中改了 PATH，宿主也随之找不到 git，报错文字相同', JSON.stringify(gone))
    await same('git 不存在：分支', { op: 'refs', cwd: repo })
    await same('git 不存在：改动', { op: 'changes', cwd: repo, options: {} })
    await same('git 不存在：diff', { op: 'diff', cwd: repo, path: 'a.txt', options: {} })
  } finally {
    process.env.PATH = savedPath
    if (savedWinPath !== undefined) process.env.Path = savedWinPath
  }
  const back = await host.runGitRead({ op: 'state', cwd: repo, light: true }, allow)
  ok(back.repo?.branch === 'feature', 'PATH 恢复后宿主重新找到 git')

  globalThis.__dieOnPost = 1
  const forksBefore = forks.length
  const retried = await host.runGitRead({ op: 'state', cwd: repo, light: true }, allow)
  ok(retried.repo?.branch === 'feature' && forks.length === forksBefore + 1, '宿主进程崩溃后重启再查一次', String(forks.length - forksBefore))

  globalThis.__dieOnPost = 2
  const fallback = await host.runGitRead({ op: 'remotes', cwd: repo }, allow)
  ok(JSON.stringify(fallback) === '["origin"]', '连续两次崩溃后回退到主进程执行', JSON.stringify(fallback))
  globalThis.__dieOnPost = 0

  host.disposeGitReadHost()
  globalThis.__forkFails = true
  const forksBeforeFail = forks.length
  const noFork = await host.runGitRead({ op: 'refs', cwd: repo }, allow)
  ok(noFork.ok === true && forks.length === forksBeforeFail, '宿主起不来时在主进程执行')
  globalThis.__forkFails = false

  host.disposeGitReadHost()
  process.env.YAN_GIT_READ_HOST = '0'
  const forksBeforeOff = forks.length
  ok(host.gitReadHostEnabled() === false, '开关关闭时宿主停用')
  const off = await host.runGitRead({ op: 'state', cwd: repo, light: false }, allow)
  ok(!!off.repo && !!off.expected && forks.length === forksBeforeOff, 'YAN_GIT_READ_HOST=0 时整体回到主进程执行')
  delete process.env.YAN_GIT_READ_HOST

  console.log(`${checks}/${checks} 通过`)
} finally {
  host.disposeGitReadHost()
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
  await new Promise((done) => setTimeout(done, 300))
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
