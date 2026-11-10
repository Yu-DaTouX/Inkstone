#!/usr/bin/env node
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const built = await build({
  entryPoints: ['src/main/workspace-mutation.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { reserveWorkspaceMutation, workspaceMutationInProgress, workspacePathsOverlap, busyWorkspaceOverlap } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)

const root = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj'
const child = process.platform === 'win32' ? 'C:\\work\\proj\\packages\\app' : '/work/proj/packages/app'
const parent = process.platform === 'win32' ? 'C:\\work' : '/work'
const sibling = process.platform === 'win32' ? 'C:\\work\\proj-other' : '/work/proj-other'
const worktree = process.platform === 'win32' ? 'C:\\work\\proj\\.worktrees\\task-1' : '/work/proj/.worktrees/task-1'

process.stdout.write('\n▌重叠目录判定\n')
await check('同一目录、尾斜杠、反斜杠写法都算重叠', async () => {
  assert.equal(workspacePathsOverlap(root, root), true)
  assert.equal(workspacePathsOverlap(root, `${root}${process.platform === 'win32' ? '\\' : '/'}`), true)
  assert.equal(workspacePathsOverlap(root, root.replace(/\\/g, '/')), true)
})

await check('父目录与子目录互相算重叠', async () => {
  assert.equal(workspacePathsOverlap(root, child), true)
  assert.equal(workspacePathsOverlap(child, root), true)
  assert.equal(workspacePathsOverlap(parent, child), true)
})

await check('同名前缀的兄弟目录、独立 worktree 不算重叠', async () => {
  assert.equal(workspacePathsOverlap(root, sibling), false)
  assert.equal(workspacePathsOverlap(sibling, root), false)
  assert.equal(workspacePathsOverlap(worktree, sibling), false)
  assert.equal(workspacePathsOverlap(`${root}2`, root), false)
})

process.stdout.write('\n▌回退期间的重叠互斥\n')
await check('子目录正在回退时，父目录和其它子目录都进不去', async () => {
  const release = reserveWorkspaceMutation(child)
  assert.ok(release, '子目录应当能预占')
  assert.equal(reserveWorkspaceMutation(child), null, '同目录第二次预占失败')
  assert.equal(reserveWorkspaceMutation(root), null, '父目录预占失败')
  assert.equal(reserveWorkspaceMutation(`${child}${process.platform === 'win32' ? '\\' : '/'}inner`), null, '更深一层预占失败')
  assert.equal(workspaceMutationInProgress(root), true, '父目录看到进行中')
  assert.equal(workspaceMutationInProgress(sibling), false, '兄弟目录不受影响')
  const other = reserveWorkspaceMutation(sibling)
  assert.ok(other, '兄弟目录仍可回退')
  other()
  release()
})

await check('父目录正在回退时子目录进不去，释放后恢复', async () => {
  const release = reserveWorkspaceMutation(parent)
  assert.ok(release, '父目录预占成功')
  assert.equal(reserveWorkspaceMutation(child), null, '子目录预占失败')
  assert.equal(reserveWorkspaceMutation(worktree), null, 'worktree 在父目录内也失败')
  release()
  assert.equal(workspaceMutationInProgress(child), false, '释放后不再阻塞')
  const again = reserveWorkspaceMutation(child)
  assert.ok(again, '释放后子目录能预占')
  again()
})

await check('重复释放不会把别人的预占清掉', async () => {
  const first = reserveWorkspaceMutation(root)
  assert.ok(first)
  const checkChild = () => reserveWorkspaceMutation(child)
  assert.equal(checkChild(), null)
  first()
  first()
  const next = checkChild()
  assert.ok(next, '释放后子目录可预占')
  next()
  assert.equal(workspaceMutationInProgress(root), false)
})

await check('忙目录列表按重叠关系判断', async () => {
  assert.equal(busyWorkspaceOverlap(child, [root]), true)
  assert.equal(busyWorkspaceOverlap(root, [child]), true)
  assert.equal(busyWorkspaceOverlap(root, [sibling]), false)
  assert.equal(busyWorkspaceOverlap(root, []), false)
})

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 重叠目录互斥：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
