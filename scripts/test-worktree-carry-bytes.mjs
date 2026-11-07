import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'yan-carry-bytes-'))
const outfile = join(root, 'git-worktree.mjs')
await build({ entryPoints: ['src/main/git-worktree.ts'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { createWorktree } = await import(pathToFileURL(outfile).href)

const gbk = (...bytes) => Buffer.from(bytes)
const LINE_A = gbk(0xd6, 0xd0, 0xce, 0xc4, 0x0a)
const LINE_B = gbk(0xb1, 0xe0, 0xc2, 0xeb, 0x0a)
const LINE_C = gbk(0xb2, 0xe2, 0xca, 0xd4, 0x0a)

try {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'yan-tests@example.invalid')
  git('config', 'user.name', 'Yan tests')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'staged.txt'), LINE_A)
  writeFileSync(join(repo, 'unstaged.txt'), LINE_A)
  git('add', '.')
  git('commit', '-qm', 'init')

  const stagedContent = Buffer.concat([LINE_A, LINE_B])
  const unstagedContent = Buffer.concat([LINE_A, LINE_C])
  writeFileSync(join(repo, 'staged.txt'), stagedContent)
  git('add', 'staged.txt')
  writeFileSync(join(repo, 'unstaged.txt'), unstagedContent)

  const carried = await createWorktree({
    cwd: repo,
    branch: 'carry-gbk',
    startPoint: null,
    targetPath: join(root, 'target'),
    carry: { staged: true, unstaged: true, untracked: [] }
  })
  assert.equal(carried.ok, true, JSON.stringify(carried.failure))
  assert.deepEqual(readFileSync(join(carried.path, 'staged.txt')), stagedContent)
  assert.deepEqual(readFileSync(join(carried.path, 'unstaged.txt')), unstagedContent)
  assert.deepEqual(readFileSync(join(repo, 'staged.txt')), stagedContent)
  assert.deepEqual(readFileSync(join(repo, 'unstaged.txt')), unstagedContent)
  console.log('✓ GBK 改动带入新工作树后逐字节一致，源工作区不变')
} finally {
  rmSync(root, { recursive: true, force: true })
}
