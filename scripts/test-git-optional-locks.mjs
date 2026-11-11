#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

const bundle = async (entry) => {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}

const policy = await bundle('src/main/git-run-policy.ts')

console.log('\n▌只读 git 命令识别')
await check('status / diff / diff --cached / log / show / ls-files 等是只读', () => {
  for (const args of [
    ['status', '--porcelain=v2'],
    ['diff'],
    ['diff', '--cached', '--binary'],
    ['diff-index', '--cached', 'abc'],
    ['log', '-n', '5'],
    ['show', 'HEAD'],
    ['rev-parse', 'HEAD'],
    ['rev-list', '--count', 'HEAD'],
    ['ls-files', '-s', '-z'],
    ['ls-tree', '-r', 'HEAD'],
    ['for-each-ref', 'refs/heads'],
    ['worktree', 'list', '--porcelain'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD']
  ]) assert.equal(policy.isReadOnlyGitInvocation(args), true, args.join(' '))
})

await check('带全局选项前缀（-c、--git-dir、--work-tree、-C）时仍按子命令判断', () => {
  const prefix = ['-c', 'core.quotepath=false', '--git-dir', 'C:/x/repo.git', '--work-tree', 'C:/p', '-C', 'C:/q']
  assert.equal(policy.isReadOnlyGitInvocation([...prefix, 'diff-index', '--cached', 'a']), true)
  assert.equal(policy.isReadOnlyGitInvocation([...prefix, 'add', '-A']), false)
  assert.equal(policy.gitSubcommand([...prefix, 'status']).name, 'status')
})

await check('写命令不算只读', () => {
  for (const args of [
    ['add', '-A'],
    ['commit', '-m', 'x'],
    ['checkout', 'main'],
    ['worktree', 'add', '-b', 'x', 'p'],
    ['worktree', 'remove', 'p'],
    ['branch', '-D', 'x'],
    ['update-ref', '-d', 'refs/x'],
    ['read-tree', '-u', '--reset', 'a'],
    ['write-tree'],
    ['commit-tree', 'a'],
    ['gc'],
    ['apply', '--cached', '-'],
    ['symbolic-ref', 'HEAD', 'refs/heads/x'],
    ['symbolic-ref', '-d', 'HEAD'],
    ['diff', '--output=out.patch'],
    ['config', 'a.b', 'c']
  ]) assert.equal(policy.isReadOnlyGitInvocation(args), false, args.join(' '))
  assert.equal(policy.isReadOnlyGitInvocation([]), false)
})

await check('readOnlyGitEnv 只对只读命令给出 GIT_OPTIONAL_LOCKS=0', () => {
  assert.deepEqual(policy.readOnlyGitEnv(['status']), { GIT_OPTIONAL_LOCKS: '0' })
  assert.deepEqual(policy.readOnlyGitEnv(['add', '-A']), {})
})

console.log('\n▌gitRun / gitReadBytes 实际传给子进程的环境')
const calls = []
const fakeChild = `
export const calls = globalThis.__gitCalls
const fake = (file, args, opts, cb) => {
  calls.push({ file, args, env: opts.env, stdin: false })
  const out = opts.encoding === 'buffer' ? Buffer.alloc(0) : ''
  queueMicrotask(() => cb(null, out, out))
  return { exitCode: null, signalCode: null, pid: 1, kill() {} }
}
export const execFile = fake
export const spawn = (file, args, opts) => {
  calls.push({ file, args, env: opts.env, stdin: true })
  const handlers = {}
  const child = {
    exitCode: null,
    signalCode: null,
    pid: 1,
    kill() {},
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: { on() {}, end() { queueMicrotask(() => handlers.close?.(0)) } },
    on(event, fn) { handlers[event] = fn; return child }
  }
  return child
}
`
globalThis.__gitCalls = calls
const serviceBuild = await build({
  entryPoints: ['src/main/git-service.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'fake-child-process',
    setup(b) {
      b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child_process', namespace: 'fake' }))
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: fakeChild, loader: 'js' }))
    }
  }]
})
const service = await import(`data:text/javascript;base64,${Buffer.from(serviceBuild.outputFiles[0].text).toString('base64')}`)
const cwd = mkdtempSync(join(tmpdir(), 'yan-git-optlocks-'))

try {
  const lastEnv = () => calls[calls.length - 1].env
  for (const args of [['status', '--porcelain'], ['diff', '--cached'], ['log', '-n', '1'], ['show', 'HEAD'], ['worktree', 'list']]) {
    await check(`gitRun ${args.join(' ')} 带 GIT_OPTIONAL_LOCKS=0`, async () => {
      await service.gitRun(cwd, args, { allowFailure: true })
      assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, '0')
    })
  }
  for (const args of [['add', '-A'], ['commit', '-m', 'x'], ['worktree', 'add', '-b', 'b', 'p'], ['branch', '-D', 'x']]) {
    await check(`gitRun ${args.join(' ')} 不带 GIT_OPTIONAL_LOCKS`, async () => {
      await service.gitRun(cwd, args, { allowFailure: true })
      assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, undefined)
    })
  }
  await check('经 stdin 传入的只读命令（影子仓库写法）同样带上，写命令不带', async () => {
    await service.gitRun(cwd, ['--git-dir', 'C:/x', '-c', 'a=b', 'diff-index', '--cached', 'x'], { allowFailure: true, stdin: 'x' })
    assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, '0')
    await service.gitRun(cwd, ['--git-dir', 'C:/x', 'update-ref', '--stdin'], { allowFailure: true, stdin: 'x' })
    assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, undefined)
  })
  await check('调用方显式传入的 env 优先', async () => {
    await service.gitRun(cwd, ['status'], { allowFailure: true, env: { GIT_OPTIONAL_LOCKS: '1' } })
    assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, '1')
  })
  await check('gitReadBytes（diff --cached 等）带 GIT_OPTIONAL_LOCKS=0', async () => {
    await service.gitReadBytes(cwd, ['diff', '--cached', '--binary'])
    assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, '0')
  })
  await check('宿主进程环境里的 GIT_OPTIONAL_LOCKS 不会泄漏给写命令', async () => {
    process.env.GIT_OPTIONAL_LOCKS = '0'
    try {
      await service.gitRun(cwd, ['commit', '-m', 'x'], { allowFailure: true })
      assert.equal(lastEnv().GIT_OPTIONAL_LOCKS, undefined)
    } finally {
      delete process.env.GIT_OPTIONAL_LOCKS
    }
  })
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

console.log(`\ngit-optional-locks: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
