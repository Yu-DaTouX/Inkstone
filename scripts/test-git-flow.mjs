#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outdir = await mkdtemp(join(tmpdir(), 'yan-git-flow-'))
const outfile = join(outdir, 'git-flow.mjs')
const entry = join(outdir, 'entry.ts')
const { writeFile } = await import('node:fs/promises')
const posix = (p) => p.replace(/\\/g, '/')
await writeFile(
  entry,
  `export * from '${posix(fileURLToPath(new URL('../src/renderer/src/features/changes/git-flow.ts', import.meta.url)))}'
export { validateBranchName } from '${posix(fileURLToPath(new URL('../src/shared/git-actions.ts', import.meta.url)))}'
`
)
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'warning' })
const flow = await import(pathToFileURL(outfile).href)

try {
  const base = {
    stagedCount: 0,
    changedCount: 0,
    branch: 'feature/x',
    detached: false,
    unborn: false,
    upstream: 'origin/feature/x',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasMessage: false
  }
  const primary = (patch) => flow.primaryAction({ ...base, ...patch })

  {
    const p = primary({ stagedCount: 2, changedCount: 3, hasMessage: true })
    assert.equal(p.kind, 'commit')
    assert.equal(p.reason, null)
    assert.equal(p.commitAndPush, true, '有暂存、有说明、有远端时可以提交并推送')
    const noMsg = primary({ stagedCount: 2, changedCount: 3 })
    assert.equal(noMsg.kind, 'commit')
    assert.equal(noMsg.reason, 'need-message')
    assert.equal(noMsg.commitAndPush, false)
    assert.equal(noMsg.commitPushReason, 'need-message')
  }
  {
    const p = primary({ ahead: 2 })
    assert.deepEqual([p.kind, p.reason], ['push', null], '提交后有未推送 → 推送')
    const dirtyAhead = primary({ ahead: 1, changedCount: 4 })
    assert.equal(dirtyAhead.kind, 'push', '还有未暂存改动时，未推送的提交仍优先给出推送')
  }
  {
    const p = primary({ upstream: null })
    assert.deepEqual([p.kind, p.reason], ['publish', null], '无上游 → 发布分支')
  }
  {
    const p = primary({})
    assert.deepEqual([p.kind, p.reason], ['up-to-date', 'synced'], '全部同步 → 已是最新且禁用')
  }
  {
    assert.deepEqual([primary({ ahead: 1, behind: 2 }).kind, primary({ ahead: 1, behind: 2 }).reason], ['push', 'diverged'])
    assert.deepEqual([primary({ behind: 3 }).kind, primary({ behind: 3 }).reason], ['behind', 'behind'])
    assert.deepEqual([primary({ changedCount: 2 }).kind, primary({ changedCount: 2 }).reason], ['commit', 'nothing-staged'])
    assert.deepEqual([primary({ hasRemote: false }).kind, primary({ hasRemote: false }).reason], ['up-to-date', 'no-remote'])
    assert.deepEqual([primary({ detached: true, branch: null }).kind, primary({ detached: true, branch: null }).reason], ['up-to-date', 'detached'])
    assert.deepEqual([primary({ unborn: true, upstream: null }).kind, primary({ unborn: true, upstream: null }).reason], ['up-to-date', 'unborn'])
    assert.equal(primary({ hasRemote: false, changedCount: 1 }).reason, 'nothing-staged', '没远端但有改动时先提示暂存')
  }
  {
    assert.equal(flow.commitPushReason({ ...base, stagedCount: 1, hasMessage: true, behind: 2 }), 'behind', '落后远端时提交并推送会被拒，不给')
    assert.equal(flow.commitPushReason({ ...base, stagedCount: 1, hasMessage: true, upstream: null }), null, '无上游时提交并推送走发布')
    assert.equal(flow.commitPushReason({ ...base, stagedCount: 1, hasMessage: true, hasRemote: false }), 'no-remote')
    assert.equal(flow.commitPushReason({ ...base, stagedCount: 1, hasMessage: true, detached: true, branch: null }), 'detached')
  }
  {
    assert.equal(flow.needsDefaultBranchConfirm('push', 'main'), true)
    assert.equal(flow.needsDefaultBranchConfirm('commit-push', 'master'), true)
    assert.equal(flow.needsDefaultBranchConfirm('publish', 'main'), true)
    assert.equal(flow.needsDefaultBranchConfirm('push', 'feature/main'), false)
    assert.equal(flow.needsDefaultBranchConfirm('push', null), false)
  }

  {
    const refs = [
      { ref: 'feature/a', label: 'refs/heads/feature/a', kind: 'local', current: false },
      { ref: 'main', label: 'refs/heads/main', kind: 'local', current: true },
      { ref: 'wt-branch', label: 'refs/heads/wt-branch', kind: 'local', current: false },
      { ref: 'origin/main', label: 'refs/remotes/origin/main', kind: 'remote', current: false },
      { ref: 'origin/review', label: 'refs/remotes/origin/review', kind: 'remote', current: false },
      { ref: 'origin', label: 'refs/remotes/origin/HEAD', kind: 'remote', current: false },
      { ref: 'v1.0', label: 'refs/tags/v1.0', kind: 'tag', current: false }
    ]
    const list = flow.buildBranchList({ refs, busyBranches: ['wt-branch'], currentBranch: 'main', query: '', running: false })
    assert.deepEqual(list.local.map((o) => o.name), ['main', 'feature/a', 'wt-branch'], '当前分支排第一，其余保持最近提交顺序')
    assert.equal(list.local[0].block, 'current')
    assert.equal(list.local[0].current, true)
    assert.equal(list.local[1].block, null)
    assert.equal(list.local[2].block, 'worktree', '被其他工作树占用的分支要禁用')
    assert.deepEqual(list.remote.map((o) => o.ref), ['origin/review'], '已有同名本地分支的远端分支不重复列出')
    assert.deepEqual(list.remote[0].pick, { kind: 'track', branch: 'review', startPoint: 'origin/review' }, '远端分支通过新建跟踪分支切换')
    assert.equal(list.local.some((o) => o.name === 'v1.0') || list.remote.some((o) => o.name === 'v1.0'), false, '标签不进分支列表')

    const running = flow.buildBranchList({ refs, busyBranches: [], currentBranch: 'main', query: '', running: true })
    assert.deepEqual(running.local.map((o) => o.block), ['current', 'running', 'running'], '目录有运行中会话时全部禁用并说明原因')
    assert.equal(running.remote[0].block, 'running')

    const filtered = flow.buildBranchList({ refs, busyBranches: [], currentBranch: 'main', query: 'REV', running: false })
    assert.deepEqual(filtered.local.map((o) => o.name), [])
    assert.deepEqual(filtered.remote.map((o) => o.ref), ['origin/review'], '搜索不区分大小写，也匹配远端名')
    assert.equal(filtered.exact, false)
    assert.equal(flow.buildBranchList({ refs, busyBranches: [], currentBranch: 'main', query: 'feature/a', running: false }).exact, true)
    assert.equal(flow.remoteLocalName('upstream/feat/x'), 'feat/x')
  }

  {
    const samples = ['', '  ', 'ok', 'feat/ok-1', '-x', '/x', 'x/', 'x.', 'x.lock', 'a..b', 'a//b', 'a@{b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\u0001b', 'x'.repeat(201)]
    for (const name of samples) {
      assert.equal(flow.branchNameIssue(name) === null, flow.validateBranchName(name) === null, `前端校验与主进程一致：${JSON.stringify(name)}`)
    }
    assert.equal(flow.branchNameIssue('Main', ['main']), 'exists', '同名（大小写不同）本地分支提示已存在')
    assert.equal(flow.branchNameIssue('a b'), 'bad-char')
    assert.equal(flow.branchNameIssue(''), 'empty')
  }

  {
    const dirty = flow.failureView({
      failure: { code: 'dirty-blocks-switch', message: '3 个未提交的文件与目标分支的改动重叠', detail: 'a.txt\nsrc/b.ts\n…还有 12 个', hint: '先提交', retrySafe: true }
    })
    assert.deepEqual(dirty.files, ['a.txt', 'src/b.ts'], '脏工作区重叠时列出冲突文件')
    assert.equal(dirty.moreFiles, 12)
    assert.equal(dirty.raw, null, '文件清单不再当作原始输出重复显示')
    assert.equal(dirty.retry, 'retry')

    const timeout = flow.failureView({ failure: { code: 'timeout', message: '推送超时，结果未知', retrySafe: false } })
    assert.equal(timeout.retry, 'refresh', '结果未知时不给一键重试')

    const committed = flow.failureView({ failure: { code: 'timeout', message: 'x', retrySafe: false }, committed: true })
    assert.equal(committed.committed, true)
    assert.equal(committed.retry, 'refresh', '已经提交时绝不能再给重试')

    const unsafe = flow.failureView({ failure: { code: 'hook', message: 'hook', detail: 'husky - pre-commit failed', retrySafe: false } })
    assert.equal(unsafe.retry, 'refresh', 'retrySafe 为假时改成刷新状态')
    assert.equal(unsafe.raw, 'husky - pre-commit failed', '原始输出可展开查看')

    const nff = flow.failureView({ failure: { code: 'non-fast-forward', message: 'rejected', retrySafe: true } })
    assert.equal(nff.next, 'fetch', '非快进给出拉取远端作为下一步')
    assert.equal(nff.retry, 'retry')
    assert.equal(flow.failureView({ failure: { code: 'no-upstream', message: 'x', retrySafe: true } }).next, 'publish', '无上游给出发布分支')
    assert.equal(flow.failureView({ failure: { code: 'auth', message: 'x', hint: 'h', retrySafe: true } }).hint, 'h')
    assert.equal(flow.failureView({ failure: { code: 'stale', message: 'x', retrySafe: false } }).retry, 'refresh')
    assert.equal(flow.failureView({ failure: { code: 'unknown', message: 'x', retrySafe: true } }).retry, 'refresh', '未知失败不给重试')
    assert.equal(flow.failureView({}, 'boom').message, 'boom')
  }

  {
    const items = [
      { path: 'a.ts', status: 'M.', untracked: false, added: 3, removed: 1 },
      { path: 'b.ts', status: '.M', untracked: false, added: 2, removed: 0 },
      { path: 'c.ts', status: 'MM', untracked: false, added: 5, removed: 5 },
      { path: 'd.ts', status: '??', untracked: true },
      { path: 'n.ts', status: 'R.', untracked: false, origPath: 'o.ts' },
      { path: 'x.ts', status: 'UU', untracked: false },
      { path: 'e.ts', status: '.M', untracked: false, staged: true, unstaged: false }
    ]
    const groups = flow.groupByStage(items)
    assert.deepEqual(groups.staged.map((i) => i.path), ['a.ts', 'c.ts', 'n.ts', 'x.ts', 'e.ts'], '主进程给的 staged 标记优先于状态码')
    assert.deepEqual(groups.unstaged.map((i) => i.path), ['b.ts', 'c.ts', 'd.ts', 'x.ts'], '部分暂存的文件两组都出现')
    assert.deepEqual(flow.unstagePaths(items[4]), ['n.ts', 'o.ts'], '取消暂存改名时连旧路径一起')
    assert.deepEqual(flow.unstagePaths(items[0]), ['a.ts'])
    assert.deepEqual(flow.stagedTotals(groups.staged.slice(0, 2)), { files: 2, added: 8, removed: 6, known: true })
    assert.equal(flow.stagedTotals([{ path: 'z' }]).known, false)
  }

  {
    assert.equal(flow.cwdBusy([{ cwd: 'C:\\Proj\\Demo\\', running: true }], 'c:/proj/demo'), true, 'Windows 路径大小写和分隔符不影响判断')
    assert.equal(flow.cwdBusy([{ cwd: 'C:/proj/demo', running: false }], 'C:/proj/demo'), false)
    assert.equal(flow.cwdBusy([{ cwd: 'C:/proj/other', running: true }], 'C:/proj/demo'), false)
    assert.equal(flow.cwdBusy([], null), false)
  }

  console.log('test-git-flow: 全部通过')
} finally {
  await rm(outdir, { recursive: true, force: true })
}
