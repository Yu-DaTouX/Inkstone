import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ipcBundle = join(tmpdir(), `yan-v3-git-read-effects-${process.pid}.mjs`)
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/ipc/git-ipc.ts', import.meta.url))],
  outfile: ipcBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning'
})
const { registerGitIpc } = await import(pathToFileURL(ipcBundle).href)

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

process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
process.env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null'
delete process.env.GIT_CONFIG_PARAMETERS
delete process.env.GIT_CONFIG_COUNT
process.env.GIT_TERMINAL_PROMPT = '0'

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
    return { ok: true, cwd: realpathSync(cwd) }
  }
  fn.calls = calls
  return fn
}

function register(authorize) {
  const reg = makeRegistrar()
  registerGitIpc(reg, { isCwdBusy: () => false, worktreeOrigins: {}, authorizeReadCwd: authorize })
  return reg
}

const workdir = mkdtempSync(join(tmpdir(), 'yan-v3-git-read-effects-'))
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

{
  const repo = join(workdir, 'rename-repo')
  const sub = join(repo, 'sub')
  mkdirSync(sub, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'yan-test'])
  git(repo, ['config', 'user.email', 'yan-test@example.com'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'outside-secret-name.txt'), 'MOVED CONTENT LINE\n')
  writeFileSync(join(sub, 'keep.txt'), 'keep\n')
  writeFileSync(join(sub, 'deleted.txt'), 'gone soon\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['mv', 'outside-secret-name.txt', join('sub', 'new.txt')])
  rmSync(join(sub, 'deleted.txt'))

  const indexBefore = readFileSync(join(repo, '.git', 'index'))
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim()

  const ungated = git(repo, ['diff', '--cached', '--', 'sub/new.txt'])
  console.log(`  info 未加护栏的 git diff 是否含范围外旧名：${ungated.includes('outside-secret-name.txt')}`)

  const authorize = makeAuthorize([sub])
  const reg = register(authorize)

  const diff = await reg.invoke('yan:git:diff', { cwd: sub, path: 'new.txt' })
  check('跨 scope rename：补丁被拒绝或不含范围外旧名', () => {
    assert.equal(diff.ok, true, diff.error)
    assert.ok(diff.patch.includes('MOVED CONTENT LINE'), '补丁应含真实内容')
    assert.ok(!diff.patch.includes('outside-secret-name.txt'), '补丁不得带出 scope 外旧路径名')
    assert.ok(!diff.patch.includes('a/outside-secret-name.txt') && !diff.patch.includes('b/outside-secret-name.txt'))
  })
  check('跨 scope rename：handler 真的调用了 authorize', () => {
    assert.ok(authorize.calls.length >= 1)
  })

  const deleted = await reg.invoke('yan:git:diff', { cwd: sub, path: 'deleted.txt' })
  check('scope 内已删除文件仍可安全看删除补丁', () => {
    assert.equal(deleted.ok, true, deleted.error)
    assert.ok(deleted.patch.includes('deleted file mode') || deleted.patch.includes('+++ /dev/null'))
    assert.ok(!deleted.patch.includes('outside-secret-name.txt'))
  })

  check('rename 仓库：handler 读取前后 index / HEAD 未变', () => {
    assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, 'index 被改动了')
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD 被改动了')
  })
}

{
  const repo = join(workdir, 'junction-repo')
  const sub = join(repo, 'sub')
  const outsideDir = join(workdir, 'outside-dir')
  mkdirSync(sub, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'file.txt'), 'OUTSIDE DATA\n')
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'yan-test'])
  git(repo, ['config', 'user.email', 'yan-test@example.com'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, '.gitkeep'), 'x\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])

  const link = join(sub, 'linkdir')
  let linkOk = false
  let linkError = ''
  try {
    symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    linkOk = true
  } catch (error) {
    linkError = error instanceof Error ? error.message : String(error)
  }

  const authorize = makeAuthorize([sub])
  const reg = register(authorize)

  if (!linkOk) {
    console.log(`  skip 中间层 junction/符号链接（本机无创建权限：${linkError}）`)
  } else {
    const resolved = realpathSync(join(link, 'file.txt'))
    check('夹具：junction 真的指向 scope 外', () => {
      assert.ok(!pathKey(resolved).startsWith(pathKey(sub) + '/'), `realpath 应在 scope 外，实际 ${resolved}`)
      assert.equal(readFileSync(resolved, 'utf8'), 'OUTSIDE DATA\n')
    })

    const escape = await reg.invoke('yan:git:diff', { cwd: sub, path: 'linkdir/file.txt' })
    check('中间层 junction：实际内容文件被拒绝，且不返回补丁', () => {
      assert.equal(escape.ok, false, '经 junction 指向 scope 外必须拒绝')
      assert.ok(escape.error, '应给错误')
      assert.equal(escape.patch, '')
    })

    const escapeGone = await reg.invoke('yan:git:diff', { cwd: sub, path: 'linkdir/gone.txt' })
    check('中间层 junction：已删除文件也拒绝（按最近存在父目录判定）', () => {
      assert.equal(escapeGone.ok, false, '已删除文件经 junction 父目录同样必须拒绝')
      assert.equal(escapeGone.patch, '')
    })
  }
}

{
  const repo = join(workdir, 'filter-repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'yan-test'])
  git(repo, ['config', 'user.email', 'yan-test@example.com'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'tracked-filter.txt'), 'base\n')
  writeFileSync(join(repo, '.gitattributes'), 'tracked-filter.txt filter=yanclean\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])

  const cleanSentinel = join(workdir, 'sentinel-clean.txt')
  const procSentinel = join(workdir, 'sentinel-process.txt')
  const fsmSentinel = join(workdir, 'sentinel-fsmonitor.txt')
  const cleanScript = join(workdir, 'clean-fixture.cjs')
  const procScript = join(workdir, 'process-fixture.cjs')
  const fsmScript = join(workdir, 'fsm-fixture.cjs')
  writeFileSync(cleanScript, "require('node:fs').appendFileSync(process.env.YAN_CLEAN_SENTINEL, 'clean\\n')\nprocess.stdin.pipe(process.stdout)\n")
  writeFileSync(procScript, "require('node:fs').appendFileSync(process.env.YAN_PROC_SENTINEL, 'proc\\n')\nprocess.stdin.pipe(process.stdout)\n")
  writeFileSync(fsmScript, "require('node:fs').appendFileSync(process.env.YAN_FSM_SENTINEL, 'fsm\\n')\nprocess.stdout.write('1\\n')\n")
  git(repo, ['config', 'filter.yanclean.required', 'true'])
  git(repo, ['config', 'core.fsmonitor', `node ${JSON.stringify(fsmScript)}`])
  writeFileSync(join(repo, 'tracked-filter.txt'), 'changed\n')

  const sentinelEnv = {
    YAN_CLEAN_SENTINEL: cleanSentinel,
    YAN_PROC_SENTINEL: procSentinel,
    YAN_FSM_SENTINEL: fsmSentinel
  }
  const clear = () => {
    rmSync(cleanSentinel, { force: true })
    rmSync(procSentinel, { force: true })
    rmSync(fsmSentinel, { force: true })
  }
  const authorize = makeAuthorize([repo])
  const reg = register(authorize)

  git(repo, ['config', 'filter.yanclean.clean', `node ${JSON.stringify(cleanScript)}`])
  clear()
  try {
    git(repo, ['diff', '--', 'tracked-filter.txt'], sentinelEnv)
  } catch {
  }
  const cleanFixtureRan = existsSync(cleanSentinel)
  check('夹具：未加护栏时 clean filter 会被 diff 执行', () => {
    assert.equal(cleanFixtureRan, true, '夹具没能触发 clean filter，否定断言无意义')
  })

  clear()
  const cleanDiff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'tracked-filter.txt' })
  check('handler diff：clean filter 未执行（无 sentinel）', () => {
    assert.equal(cleanDiff.ok, true, cleanDiff.error)
    assert.equal(existsSync(cleanSentinel), false, 'clean filter 被执行了')
    assert.ok(cleanDiff.patch.includes('changed'), '补丁应含真实改动')
  })

  git(repo, ['config', '--unset', 'filter.yanclean.clean'])
  git(repo, ['config', 'filter.yanclean.process', `node ${JSON.stringify(procScript)}`])
  clear()
  try {
    git(repo, ['diff', '--', 'tracked-filter.txt'], sentinelEnv)
  } catch {
  }
  const procFixtureRan = existsSync(procSentinel)
  check('夹具：未加护栏时 process filter 会被 diff 执行', () => {
    assert.equal(procFixtureRan, true, '夹具没能触发 process filter，否定断言无意义')
  })

  clear()
  const procDiff = await reg.invoke('yan:git:diff', { cwd: repo, path: 'tracked-filter.txt' })
  check('handler diff：process filter 未执行（无 sentinel）', () => {
    assert.equal(procDiff.ok, true, procDiff.error)
    assert.equal(existsSync(procSentinel), false, 'process filter 被执行了')
    assert.ok(procDiff.patch.includes('changed'), '补丁应含真实改动')
  })

  clear()
  try {
    git(repo, ['status', '--porcelain=v2', '--untracked-files=all'], sentinelEnv)
  } catch {
  }
  const fsmFixtureRan = existsSync(fsmSentinel)
  if (fsmFixtureRan) {
    console.log('  info 夹具证明 core.fsmonitor 会被 status 执行')
  } else {
    console.log('  skip core.fsmonitor 夹具未触发（本机 git 不执行该钩子）')
  }

  const indexBefore = readFileSync(join(repo, '.git', 'index'))
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim()

  clear()
  const changes = await reg.invoke('yan:git:changes', repo)
  check('handler changes：core.fsmonitor 未执行（无 sentinel）', () => {
    assert.equal(changes.ok, true, changes.error)
    assert.equal(existsSync(fsmSentinel), false, 'core.fsmonitor 被执行了')
    assert.ok(changes.files.some((f) => f.path === 'tracked-filter.txt'), '应列出被改文件')
  })

  check('filter 仓库：handler 读取前后 index / HEAD 未变', () => {
    assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, 'index 被改动了')
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD 被改动了')
  })
}

rmSync(workdir, { recursive: true, force: true })
try {
  rmSync(ipcBundle, { force: true })
} catch {
}

if (failures > 0) {
  console.error(`\nP3 git-read-effects：${failures} 项失败`)
  process.exit(1)
}
console.log('\nP3 git-read-effects：全部通过（只读、隔离临时仓库）')
