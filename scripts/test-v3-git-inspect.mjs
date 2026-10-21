import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ipcBundle = join(tmpdir(), `yan-v3-git-inspect-ipc-${process.pid}.mjs`)
const inspectBundle = join(tmpdir(), `yan-v3-git-inspect-lib-${process.pid}.mjs`)
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/ipc/git-ipc.ts', import.meta.url))],
  outfile: ipcBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning'
})
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/git-inspect.ts', import.meta.url))],
  outfile: inspectBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning'
})
const { registerGitIpc } = await import(pathToFileURL(ipcBundle).href)
const { normalizeRelPath } = await import(pathToFileURL(inspectBundle).href)

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'yan-test',
  GIT_AUTHOR_EMAIL: 'yan-test@example.com',
  GIT_COMMITTER_NAME: 'yan-test',
  GIT_COMMITTER_EMAIL: 'yan-test@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
}
function git(cwd, args, extraEnv) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: extraEnv ? { ...GIT_ENV, ...extraEnv } : GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

const PROCESS_ENV_PREV = {}
for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_TERMINAL_PROMPT']) {
  PROCESS_ENV_PREV[key] = process.env[key]
}
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
process.env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null'
delete process.env.GIT_CONFIG_PARAMETERS
delete process.env.GIT_CONFIG_COUNT
process.env.GIT_TERMINAL_PROMPT = '0'
function restoreProcessEnv() {
  for (const [key, value] of Object.entries(PROCESS_ENV_PREV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function makeRegistrar() {
  const handlers = new Map()
  return {
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    rawHandle(channel, fn) {
      handlers.set(channel, fn)
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel)
      assert.ok(fn, `没有注册处理器：${channel}`)
      return fn(...args)
    },
    has(channel) {
      return handlers.has(channel)
    }
  }
}

function pathKey(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function makeAuthorize(allowedAbs) {
  const allowed = new Set(allowedAbs.map((path) => pathKey(realpathSync(path))))
  const calls = []
  const fn = async (cwd) => {
    calls.push(String(cwd ?? ''))
    let real
    try {
      real = pathKey(realpathSync(cwd))
    } catch {
      return { ok: false, error: '工作目录不存在或不可访问' }
    }
    if (!allowed.has(real)) return { ok: false, error: '工作目录不属于已授权的项目或会话' }
    return { ok: true, cwd: resolve(cwd) }
  }
  fn.calls = calls
  return fn
}

function register(authorize) {
  const reg = makeRegistrar()
  registerGitIpc(reg, {
    isCwdBusy: () => false,
    worktreeOrigins: {},
    authorizeReadCwd: authorize
  })
  return reg
}

const workdir = mkdtempSync(join(tmpdir(), 'yan-v3-git-inspect-'))
let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const repo = join(workdir, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-q', '-b', 'main'])
git(repo, ['config', 'user.name', 'yan-test'])
git(repo, ['config', 'user.email', 'yan-test@example.com'])
git(repo, ['config', 'core.autocrlf', 'false'])

writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\nthree\n')
writeFileSync(join(repo, 'both.txt'), 'l1\nl2\n')
writeFileSync(join(repo, '中文 及空格.txt'), '第一行\n')
writeFileSync(join(repo, 'gone.txt'), 'bye\n')
writeFileSync(join(repo, 'old-name.txt'), 'rename me\n')
mkdirSync(join(repo, 'subdir'), { recursive: true })
writeFileSync(join(repo, 'subdir', 'inner.txt'), 'inner\n')
mkdirSync(join(repo, 'assets'), { recursive: true })
git(repo, ['add', '-A'])
git(repo, ['commit', '-q', '-m', 'init'])

writeFileSync(join(repo, 'tracked.txt'), 'one\nTWO\nthree\nfour\n')
writeFileSync(join(repo, 'both.txt'), 'staged line\n')
git(repo, ['add', 'both.txt'])
writeFileSync(join(repo, 'both.txt'), 'worktree line\n')
writeFileSync(join(repo, '中文 及空格.txt'), '第一行\n改过的第二行\n')
git(repo, ['add', '中文 及空格.txt'])
writeFileSync(join(repo, 'new-staged.txt'), 'brand new\n')
git(repo, ['add', 'new-staged.txt'])
git(repo, ['mv', 'old-name.txt', 'new-name.txt'])
rmSync(join(repo, 'gone.txt'))
writeFileSync(join(repo, 'untracked.txt'), 'u1\nu2\nu3\n')
writeFileSync(join(repo, 'assets', 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))
writeFileSync(join(repo, 'subdir', 'inner.txt'), 'inner changed\n')

let symlinkOk = false
const outsideFile = join(workdir, 'outside-secret.txt')
writeFileSync(outsideFile, 'TOP SECRET\n')
try {
  symlinkSync(outsideFile, join(repo, 'link-out.txt'))
  symlinkOk = true
} catch {
  symlinkOk = false
}

const indexPath = join(repo, '.git', 'index')
const indexBefore = readFileSync(indexPath)
const headBefore = git(repo, ['rev-parse', 'HEAD']).trim()

const authorize = makeAuthorize([repo])
const reg = register(authorize)

let changes
{
  const before = authorize.calls.length
  changes = await reg.invoke('yan:git:changes', repo)
  assert.ok(authorize.calls.length > before, 'handler 必须真的调用 authorizeReadCwd')
}
check('changes 返回 ok 与仓库根', () => {
  assert.equal(changes.ok, true, changes.error)
  assert.equal(pathKey(changes.root), pathKey(realpathSync(repo)))
  assert.equal(changes.scope, '.')
})
check('仓库根被再次授权（calls 里出现 root）', () => {
  assert.ok(authorize.calls.some((cwd) => pathKey(cwd) === pathKey(repo)), 'authorize 必须收到仓库根')
})
const byPath = new Map(changes.files.map((file) => [file.path, file]))
check('未暂存修改：tracked.txt', () => {
  const entry = byPath.get('tracked.txt')
  assert.ok(entry, '缺少 tracked.txt')
  assert.equal(entry.x, '.')
  assert.equal(entry.y, 'M')
  assert.equal(entry.staged, false)
  assert.equal(entry.unstaged, true)
})
check('已暂存 + 未暂存：both.txt', () => {
  const entry = byPath.get('both.txt')
  assert.ok(entry, '缺少 both.txt')
  assert.equal(entry.x, 'M')
  assert.equal(entry.y, 'M')
  assert.equal(entry.staged, true)
  assert.equal(entry.unstaged, true)
})
check('行数统计：tracked.txt +2 -1、未跟踪文件按行计、二进制为 0', () => {
  assert.equal(byPath.get('tracked.txt').added, 2)
  assert.equal(byPath.get('tracked.txt').removed, 1)
  assert.equal(byPath.get('both.txt').added, 1)
  assert.equal(byPath.get('both.txt').removed, 2)
  assert.equal(byPath.get('中文 及空格.txt').added, 1)
  assert.equal(byPath.get('gone.txt').removed, 1)
  assert.equal(byPath.get('untracked.txt').added, 3)
  assert.equal(byPath.get('assets/blob.bin').added, 0)
  const sumAdded = changes.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const sumRemoved = changes.files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  assert.equal(changes.added, sumAdded)
  assert.equal(changes.removed, sumRemoved)
  assert.ok(changes.added > 0 && changes.removed > 0)
})
check('中文 + 空格 + 已暂存', () => {
  const entry = byPath.get('中文 及空格.txt')
  assert.ok(entry, '缺少中文空格路径')
  assert.equal(entry.staged, true)
})
check('已暂存重命名', () => {
  assert.ok(byPath.has('new-name.txt'), '缺少 rename 新路径')
  const entry = byPath.get('new-name.txt')
  assert.equal(entry.x, 'R')
})
check('已暂存新增', () => {
  assert.ok(byPath.has('new-staged.txt'), '缺少新增文件')
  assert.equal(byPath.get('new-staged.txt').x, 'A')
})
check('未暂存删除', () => {
  const entry = byPath.get('gone.txt')
  assert.ok(entry, '缺少删除文件')
  assert.equal(entry.y, 'D')
})
check('未跟踪文件', () => {
  const entry = byPath.get('untracked.txt')
  assert.ok(entry, '缺少未跟踪文件')
  assert.equal(entry.untracked, true)
  assert.equal(entry.x, '?')
  assert.equal(entry.staged, false, '未跟踪文件不在 index 里，staged 必须为 false')
  assert.equal(entry.unstaged, true)
})
check('子目录改动也在范围里', () => {
  assert.ok(byPath.has('subdir/inner.txt'), '缺少 subdir/inner.txt')
})

{
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'both.txt' })
  check('both.txt：ok / staged / unstaged / 两个片段', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.equal(diff.staged, true)
    assert.equal(diff.unstaged, true)
    assert.ok((diff.patch.match(/^diff --git /gm) ?? []).length >= 2, '应含两段 diff --git')
    assert.ok(diff.patch.includes('+staged line'), '缺已暂存片段内容')
    assert.ok(diff.patch.includes('+worktree line'), '缺未暂存片段内容')
    assert.equal(diff.truncated, false)
  })
}
{
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: '中文 及空格.txt' })
  check('中文空格 diff：ok 且含真实改动', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.ok(diff.patch.includes('改过的第二行'), '补丁应含中文内容')
  })
}
{
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'gone.txt' })
  check('删除文件 diff', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.ok(diff.patch.includes('deleted file mode') || diff.patch.includes('+++ /dev/null'), '应是删除补丁')
  })
}
{
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'new-name.txt' })
  check('重命名 diff 不含旧路径（--no-renames 防跨范围泄漏）', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.ok(diff.patch.includes('new file mode') || diff.patch.includes('+++ b/new-name.txt'), '新路径应作为新增呈现')
    assert.ok(!diff.patch.includes('old-name.txt'), '单文件补丁不应带出旧路径')
  })
}

{
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'untracked.txt' })
  check('未跟踪文件：安全新文件补丁', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.equal(diff.untracked, true)
    assert.equal(diff.binary, false)
    assert.ok(diff.patch.includes('new file mode 100644'))
    assert.ok(diff.patch.includes('+u1') && diff.patch.includes('+u3'))
    assert.ok(diff.patch.includes('--- /dev/null'))
  })
}
{
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'assets/blob.bin' })
  check('未跟踪二进制：只给说明行，无 base85 大块', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.equal(diff.binary, true)
    assert.ok(!diff.patch.includes('GIT binary patch'), '不应有 git binary patch')
    assert.ok(!/[A-Za-z0-9+/]{80,}/.test(diff.patch), '不应有 base85 大块')
  })
}

{
  const lines = []
  for (let i = 0; i < 150_000; i++) lines.push(`line-${i}-0123456789`)
  lines.push('LASTLINE-SHOULD-BE-CUT')
  writeFileSync(join(repo, 'big.txt'), lines.join('\n') + '\n')
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'big.txt' })
  check('超大未跟踪文件：truncated 且不冒充完整', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.equal(diff.truncated, true, '应标记截断')
    assert.ok(diff.bytes >= Buffer.byteLength(diff.patch, 'utf8'), 'bytes 不应小于返回的补丁')
    assert.ok(!diff.patch.includes('LASTLINE-SHOULD-BE-CUT'), '被截断的尾部不应出现')
  })
}

{
  const bad = [
    ['绝对路径', join(repo, 'tracked.txt')],
    ['父目录', '../outside-secret.txt'],
    ['父目录混入', 'subdir/../../outside-secret.txt'],
    ['魔法 pathspec', ':(glob)*'],
    ['排除魔法', '!tracked.txt'],
    ['以 - 开头', '-rf'],
    ['NUL', 'a\u0000b'],
    ['前导斜杠', '/tracked.txt'],
    ['目录', 'subdir']
  ]
  for (const [name, path] of bad) {
    const diff = await reg.invoke('yan:git:diff', { cwd: repo, path })
    check(`拒绝路径：${name}`, () => {
      assert.equal(diff.ok, false, `${name} 应被拒绝`)
      assert.ok(diff.error, `${name} 应给错误`)
      assert.equal(diff.patch, '')
    })
  }
}

if (symlinkOk) {
  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'link-out.txt' })
  check('软链接逃逸被拒绝', () => {
    assert.equal(diff.ok, false, '软链接不应被跟随读取')
    assert.equal(diff.patch, '')
    assert.match(String(diff.error), /符号链接|超出授权范围/)
  })
} else {
  console.log('  skip 软链接逃逸（本机无创建符号链接权限）')
}

{
  const denyAuthorize = makeAuthorize([])
  const regDeny = register(denyAuthorize)
  const denied = await regDeny.invoke('yan:git:changes', repo)
  const deniedDiff = await regDeny.invoke('yan:git:diff', { cwd: repo, path: 'tracked.txt' })
  check('未授权 cwd：changes fail closed 且调用了 authorize', () => {
    assert.ok(denyAuthorize.calls.length >= 1, 'authorize 必须被调用')
    assert.equal(denied.ok, false)
    assert.ok(denied.error)
    assert.deepEqual(denied.files, [])
  })
  check('未授权 cwd：diff fail closed', () => {
    assert.equal(deniedDiff.ok, false)
    assert.ok(deniedDiff.error)
    assert.equal(deniedDiff.patch, '')
  })

  git(repo, ['remote', 'add', 'origin', 'git@github.com:inkstone/demo.git'])
  const cachedBefore = git(repo, ['diff', '--cached', '--name-only']).trim()
  const deniedState = await regDeny.invoke('yan:git:state', repo)
  const deniedRefs = await regDeny.invoke('yan:git:refs', repo)
  const deniedUntracked = await regDeny.invoke('yan:git:untracked', repo)
  const deniedWorktrees = await regDeny.invoke('yan:git:worktrees', repo)
  const deniedIdentity = await regDeny.invoke('yan:git:identity', repo)
  const deniedRemotes = await regDeny.invoke('yan:git:remotes', repo)
  const deniedAction = await regDeny.invoke('yan:git:action', {
    requestId: 'deny-stage-all',
    cwd: repo,
    kind: 'stage-all',
    expected: { head: null, indexDigest: '', statusDigest: '' }
  })
  check('未授权 cwd：state / refs / untracked / worktrees 全部 fail closed', () => {
    assert.equal(deniedState.repo, null)
    assert.ok(deniedState.error)
    assert.equal(deniedRefs.ok, false)
    assert.deepEqual(deniedRefs.refs, [])
    assert.ok(deniedRefs.error)
    assert.deepEqual(deniedUntracked, [])
    assert.equal(deniedWorktrees.ok, false)
    assert.deepEqual(deniedWorktrees.worktrees, [])
  })
  check('未授权 cwd：identity / remotes 不泄露', () => {
    assert.equal(deniedIdentity, null)
    assert.deepEqual(deniedRemotes, [])
  })
  check('未授权 cwd：git 写操作被拒且真的没改 index', () => {
    assert.equal(deniedAction.ok, false)
    assert.ok(deniedAction.failure?.message)
    assert.equal(git(repo, ['diff', '--cached', '--name-only']).trim(), cachedBefore)
  })
  const allowedIdentity = await register(makeAuthorize([repo])).invoke('yan:git:identity', repo)
  const allowedRemotes = await reg.invoke('yan:git:remotes', repo)
  check('已授权 cwd：同样的通道仍能读到内容（拒绝不是因为仓库没内容）', () => {
    assert.equal(allowedIdentity?.name, 'demo')
    assert.deepEqual(allowedRemotes, ['origin'])
  })
}

{
  const sub = join(repo, 'subdir')
  const subAuthorize = makeAuthorize([sub])
  const regSub = register(subAuthorize)
  const subChanges = await regSub.invoke('yan:git:changes', sub)
  check('子目录授权：范围收窄，只列范围内文件', () => {
    assert.equal(subChanges.ok, true, subChanges.error)
    assert.equal(subChanges.scope, 'subdir')
    assert.ok(subChanges.files.length > 0)
    assert.deepEqual(subChanges.files.map((file) => file.path), ['inner.txt'])
  })
  check('子目录授权：仓库根也被尝试授权（并被拒绝）', () => {
    assert.ok(
      subAuthorize.calls.some((cwd) => pathKey(cwd) === pathKey(repo)),
      'authorize 应收到仓库根并被拒'
    )
    assert.ok(
      subAuthorize.calls.some((cwd) => pathKey(cwd) === pathKey(sub)),
      'authorize 应收到子目录'
    )
  })
  const insideDiff = await regSub.invoke('yan:git:diff', { cwd: sub, path: 'inner.txt' })
  check('子目录内 diff 可读', () => {
    assert.equal(insideDiff.ok, true, insideDiff.error)
    assert.ok(insideDiff.patch.includes('inner changed') || insideDiff.patch.includes('+inner'))
  })
  const parentDiff = await regSub.invoke('yan:git:diff', { cwd: sub, path: '../tracked.txt' })
  check('子目录授权：父目录文件不可读', () => {
    assert.equal(parentDiff.ok, false)
  })
  const siblingDiff = await regSub.invoke('yan:git:diff', { cwd: sub, path: 'tracked.txt' })
  check('子目录授权：同级文件按范围内路径解析（不存在 → 拒绝）', () => {
    assert.equal(siblingDiff.ok, false)
  })
}

{
  const unborn = join(workdir, 'unborn')
  mkdirSync(unborn, { recursive: true })
  git(unborn, ['init', '-q', '-b', 'main'])
  git(unborn, ['config', 'user.name', 'yan-test'])
  git(unborn, ['config', 'user.email', 'yan-test@example.com'])
  writeFileSync(join(unborn, 'first.txt'), 'hello\n')
  git(unborn, ['add', 'first.txt'])
  const regUnborn = register(makeAuthorize([unborn]))
  const unbornChanges = await regUnborn.invoke('yan:git:changes', unborn)
  const unbornDiff = await regUnborn.invoke('yan:git:diff', { cwd: unborn, path: 'first.txt' })
  check('无 HEAD：changes 标记 unborn', () => {
    assert.equal(unbornChanges.ok, true, unbornChanges.error)
    assert.equal(unbornChanges.unborn, true)
    assert.equal(unbornChanges.head, null)
  })
  check('无 HEAD：--cached diff 仍可读', () => {
    assert.equal(unbornDiff.ok, true, unbornDiff.error)
    assert.equal(unbornDiff.staged, true)
    assert.ok(unbornDiff.patch.includes('new file mode'))
    assert.ok(unbornDiff.patch.includes('+hello'))
  })
}

{
  const indexAfter = readFileSync(indexPath)
  const headAfter = git(repo, ['rev-parse', 'HEAD']).trim()
  check('index 字节不变', () => {
    assert.deepEqual(indexAfter, indexBefore, 'index 被改动了')
  })
  check('HEAD 不变', () => {
    assert.equal(headAfter, headBefore)
  })
}

{
  const sentinelExt = join(workdir, 'sentinel-ext.txt')
  const sentinelConv = join(workdir, 'sentinel-conv.txt')
  const extScript = join(workdir, 'ext.cjs')
  const convScript = join(workdir, 'conv.cjs')
  writeFileSync(extScript, "require('node:fs').writeFileSync(process.env.YAN_EXT_SENTINEL, 'x')\n")
  writeFileSync(convScript, "require('node:fs').writeFileSync(process.env.YAN_CONV_SENTINEL, 'x')\n")
  process.env.YAN_EXT_SENTINEL = sentinelExt
  process.env.YAN_CONV_SENTINEL = sentinelConv

  git(repo, ['config', 'diff.external', `node ${JSON.stringify(extScript)}`])
  try {
    git(repo, ['--no-pager', 'diff', '--ext-diff', '--', 'tracked.txt'], { YAN_EXT_SENTINEL: sentinelExt })
  } catch {
  }
  const fixtureRan = existsSync(sentinelExt)
  rmSync(sentinelExt, { force: true })
  check('夹具：external diff 机制可运行', () => {
    assert.equal(fixtureRan, true, '夹具本身没能执行 external diff，否定断言无意义')
  })

  const diff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'tracked.txt' })
  check('external diff 未执行（无 sentinel）', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.equal(existsSync(sentinelExt), false, 'diff.external 被执行了')
  })

  git(repo, ['config', '--unset', 'diff.external'])
  writeFileSync(join(repo, '.gitattributes'), '*.txt diff=yanconv\n')
  git(repo, ['config', 'diff.yanconv.textconv', `node ${JSON.stringify(convScript)}`])
  let convFixtureRan = false
  try {
    git(repo, ['--no-pager', 'diff', '--textconv', '--', 'tracked.txt'], { YAN_CONV_SENTINEL: sentinelConv })
    convFixtureRan = existsSync(sentinelConv)
  } catch {
    convFixtureRan = existsSync(sentinelConv)
  }
  rmSync(sentinelConv, { force: true })
  if (convFixtureRan) {
    const diff2 = await reg.invoke('yan:git:diff', { cwd: repo, path: 'tracked.txt' })
    check('textconv 未执行（无 sentinel）', () => {
      assert.equal(diff2.ok, true, diff2.error)
      assert.equal(existsSync(sentinelConv), false, 'textconv 被执行了')
    })
  } else {
    console.log('  skip textconv 否定断言（夹具未触发 textconv）')
  }
  delete process.env.YAN_EXT_SENTINEL
  delete process.env.YAN_CONV_SENTINEL
}

check('normalizeRelPath', () => {
  assert.equal(normalizeRelPath('a/b.txt'), 'a/b.txt')
  assert.equal(normalizeRelPath('中文 及空格.txt'), '中文 及空格.txt')
  assert.equal(normalizeRelPath('/a'), null)
  assert.equal(normalizeRelPath('C:/a'), null)
  assert.equal(normalizeRelPath('a/../b'), null)
  assert.equal(normalizeRelPath('a/./b'), null)
  assert.equal(normalizeRelPath(':(glob)*'), null)
  assert.equal(normalizeRelPath('-x'), null)
  assert.equal(normalizeRelPath('a\u0000b'), null)
  assert.equal(normalizeRelPath(''), null)
})

rmSync(workdir, { recursive: true, force: true })
restoreProcessEnv()
try {
  rmSync(ipcBundle, { force: true })
  rmSync(inspectBundle, { force: true })
} catch {
}

if (failures > 0) {
  console.error(`\nP3 git-inspect：${failures} 项失败`)
  process.exit(1)
}
console.log('\nP3 git-inspect：全部通过（只读、隔离临时仓库）')
