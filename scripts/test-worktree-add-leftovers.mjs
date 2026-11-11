#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const hooks = { afterAdd: null, failAdd: null }
globalThis.__worktreeAddHooks = hooks
const realService = resolve('src/main/git-service.ts').replace(/\\/g, '/')
const wrapper = `
import * as real from '${realService}'
export * from '${realService}'
export const gitRun = async (cwd, args, opts) => {
  const isAdd = args[0] === 'worktree' && args[1] === 'add'
  const hooks = globalThis.__worktreeAddHooks
  if (isAdd && hooks.failAdd) {
    const mode = hooks.failAdd
    await hooks.beforeFail?.(cwd, args)
    if (mode === 'run-then-timeout') await real.gitRun(cwd, args, opts)
    return { ok: false, stdout: '', stderr: mode === 'run-then-timeout' ? '' : 'fatal: simulated failure', error: 'timeout', timedOut: mode === 'run-then-timeout' }
  }
  return real.gitRun(cwd, args, opts)
}
`
const built = await build({
  entryPoints: ['src/main/git-worktree.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'wrap-git-service',
    setup(b) {
      b.onResolve({ filter: /^\.\/git-service$/ }, () => ({ path: 'git-service-wrapper', namespace: 'wrap' }))
      b.onLoad({ filter: /.*/, namespace: 'wrap' }, () => ({ contents: wrapper, loader: 'js', resolveDir: process.cwd() }))
    }
  }]
})
const wt = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const root = mkdtempSync(join(tmpdir(), 'yan-wt-leftover-'))
const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'yan-tests@example.invalid')
git('config', 'user.name', 'Yan tests')
writeFileSync(join(repo, 'a.txt'), 'a\n')
git('add', '.')
git('commit', '-qm', 'init')
const branches = () => git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)

try {
  console.log('\n▌add 超时后保留内容并给出诊断（D-15）')
  await check('add 实际已完成但报超时：返回带诊断的超时错误，目录与分支都不删', async () => {
    const target = join(root, 'wt-a')
    hooks.failAdd = 'run-then-timeout'
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-a', startPoint: null, targetPath: target })
    hooks.failAdd = null
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'timeout')
    assert.equal(result.failure.retrySafe, false)
    assert.ok(result.failure.detail?.includes(target), result.failure.detail)
    assert.match(result.failure.hint, /git worktree remove --force/)
    assert.ok(existsSync(join(target, 'a.txt')), '目录内容必须还在')
    assert.ok(branches().includes('feat-a'), '分支必须还在')
  })

  await check('同名重试：给出"可能是上次中断的残留"的可操作提示，仍不删除任何东西', async () => {
    const target = join(root, 'wt-a')
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-a', startPoint: null, targetPath: target })
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'branch-exists')
    assert.match(result.failure.hint, /上一次创建被中断|interrupted/)
    assert.ok(result.failure.detail?.includes(target))
    assert.ok(existsSync(join(target, 'a.txt')))
    assert.ok(branches().includes('feat-a'))
    const sameFolder = await wt.createWorktree({ cwd: repo, branch: 'feat-a-2', startPoint: null, targetPath: target })
    assert.equal(sameFolder.failure.code, 'path-rejected')
    assert.match(sameFolder.failure.hint, /上一次创建被中断|interrupted/)
    assert.ok(existsSync(join(target, 'a.txt')))
  })

  await check('目录非空且未登记、分支已建：保留两者并说明下一步', async () => {
    const target = join(root, 'wt-b')
    hooks.failAdd = 'plain'
    hooks.beforeFail = () => {
      mkdirSync(target)
      writeFileSync(join(target, 'user-file.txt'), 'keep me')
      git('branch', 'feat-b')
    }
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-b', startPoint: null, targetPath: target })
    hooks.failAdd = null
    hooks.beforeFail = null
    assert.equal(result.ok, false)
    assert.ok(result.failure.detail?.includes(target))
    assert.match(result.failure.hint, /没有替你删除|did not delete/)
    assert.equal(readFileSync(join(target, 'user-file.txt'), 'utf8'), 'keep me')
    assert.ok(branches().includes('feat-b'))
  })

  await check('确认是本次刚建出的空目录与未被使用的分支（仍在起点）：才清理', async () => {
    const target = join(root, 'wt-c')
    hooks.failAdd = 'plain'
    hooks.beforeFail = () => {
      mkdirSync(target)
      git('branch', 'feat-c')
    }
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-c', startPoint: null, targetPath: target })
    hooks.failAdd = null
    hooks.beforeFail = null
    assert.equal(result.ok, false)
    assert.equal(existsSync(target), false, '空目录应被清掉')
    assert.ok(!branches().includes('feat-c'), '没有被使用的分支应被清掉')
    assert.ok(!result.failure.detail?.includes('feat-c'))
  })

  await check('分支已经有新提交时不当作残留清理', async () => {
    const target = join(root, 'wt-d')
    hooks.failAdd = 'plain'
    hooks.beforeFail = () => {
      mkdirSync(target)
      git('branch', 'feat-d')
      git('checkout', '-q', 'feat-d')
      writeFileSync(join(repo, 'b.txt'), 'b\n')
      git('add', 'b.txt')
      git('commit', '-qm', 'work on feat-d')
      git('checkout', '-q', '-')
    }
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-d', startPoint: null, targetPath: target })
    hooks.failAdd = null
    hooks.beforeFail = null
    assert.equal(result.ok, false)
    assert.ok(branches().includes('feat-d'))
    assert.match(result.failure.hint, /git branch -d feat-d/)
  })

  await check('普通失败且没有残留：仍返回原有分类，不多说', async () => {
    const target = join(root, 'wt-e')
    hooks.failAdd = 'plain'
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-e', startPoint: null, targetPath: target })
    hooks.failAdd = null
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'unknown')
    assert.ok(!branches().includes('feat-e'))
  })

  await check('正常新建仍然成功', async () => {
    const target = join(root, 'wt-ok')
    const result = await wt.createWorktree({ cwd: repo, branch: 'feat-ok', startPoint: null, targetPath: target })
    assert.equal(result.ok, true, JSON.stringify(result.failure))
    assert.ok(existsSync(join(target, 'a.txt')))
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nworktree-add-leftovers: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
