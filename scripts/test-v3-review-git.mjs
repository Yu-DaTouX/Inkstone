/**
 * 评审 Git 写适配单测（WP-50）。
 *
 * 用 esbuild 现场编译 `src/main/review/git.ts`，注入 **fake exec / fake 确认**，
 * **绝不真的 commit / push / gh / 联网 / 读凭证**。可独立执行：
 *
 *   node scripts/test-v3-review-git.mjs
 *
 * 覆盖：
 *   · 参数数组调用（不是 shell 字符串）：含空格 / 分号的标题仍是单个 argv 元素；
 *   · push 与 PR 必须先过窄目标确认；没确认时 exec 一次都不调用；
 *   · 缺 gh 返回 `gh-missing`、未登录返回 `gh-not-authenticated`，都可恢复、不假成功；
 *   · 提交说明为空等本地校验在执行前拦下。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

let step = 0
function ok(label) {
  step += 1
  console.log(`  ok ${step}. ${label}`)
}

const entry = join(process.cwd(), 'src', 'main', 'review', 'git.ts')
const outDir = await mkdtemp(join(tmpdir(), 'yan-review-git-'))

try {
  const mod = await import(pathToFileURL(await compile(entry, join(outDir, 'git.mjs'))).href)
  const { ReviewGitAdapter } = mod

  function fakeExec(kind) {
    const calls = []
    return {
      calls,
      run: async (cwd, args, opts) => {
        calls.push({ cwd, args, opts })
        return { ok: true, stdout: '', stderr: '' }
      }
    }
  }

  // 1. commit：固定 argv，参数数组
  {
    const git = fakeExec()
    git.run = async (cwd, args) => {
      git.calls.push({ cwd, args })
      return { ok: true, stdout: '[main abc1234] 说明', stderr: '' }
    }
    const confirms = []
    const adapter = new ReviewGitAdapter({ gitExec: git, ghExec: fakeExec(), confirm: { confirm: async (r) => (confirms.push(r), true) } })
    const res = await adapter.commit({ cwd: '/repo', message: '提交说明 带空格; 与分号' })
    assert.equal(res.ok, true)
    assert.equal(res.commit, 'abc1234')
    assert.deepEqual(git.calls[0].args, ['commit', '-m', '提交说明 带空格; 与分号'])
    assert.equal(confirms.length, 0, 'commit 不需要确认')
    ok('commit 用参数数组、不经 shell；提交说明保留为单个 argv 元素')
  }

  // 2. commit 空说明在执行前拦下
  {
    const git = fakeExec()
    const adapter = new ReviewGitAdapter({ gitExec: git, ghExec: fakeExec(), confirm: { confirm: async () => true } })
    const res = await adapter.commit({ cwd: '/repo', message: '   ' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'invalid-input')
    assert.equal(git.calls.length, 0)
    ok('空提交说明本地拦下，不调用 git')
  }

  // 3. push 未确认：不发命令
  {
    const git = fakeExec()
    const requests = []
    const adapter = new ReviewGitAdapter({
      gitExec: git,
      ghExec: fakeExec(),
      confirm: { confirm: async (r) => (requests.push(r), false) }
    })
    const res = await adapter.push({ cwd: '/repo', remote: 'origin', branch: 'feat/x', setUpstream: true })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not-confirmed')
    assert.equal(git.calls.length, 0)
    assert.equal(requests[0].action, 'push')
    assert.equal(requests[0].remote, 'origin')
    assert.equal(requests[0].branch, 'feat/x')
    ok('push 未确认时不执行，确认请求带窄目标 remote/branch')
  }

  // 4. push 已确认：固定 argv
  {
    const git = fakeExec()
    const adapter = new ReviewGitAdapter({ gitExec: git, ghExec: fakeExec(), confirm: { confirm: async () => true } })
    const res = await adapter.push({ cwd: '/repo', remote: 'origin', branch: 'feat/x', setUpstream: true })
    assert.equal(res.ok, true)
    assert.deepEqual(git.calls[0].args, ['push', '--set-upstream', '--', 'origin', 'feat/x'])
    ok('push 确认后 argv 固定为 buildPushArgs 的形状')
  }

  // 5. gh 缺失
  {
    const adapter = new ReviewGitAdapter({
      gitExec: fakeExec(),
      ghExec: { run: async () => ({ ok: false, stdout: '', stderr: '', notFound: true, error: '没有找到 gh' }) },
      confirm: { confirm: async () => true }
    })
    const status = await adapter.ghStatus('/repo')
    assert.equal(status.installed, false)
    assert.match(status.hint, /安装/)
    const pr = await adapter.createPullRequest({ cwd: '/repo', base: 'main', head: 'feat', title: 'T', body: 'B', draft: false, remote: null })
    assert.equal(pr.ok, false)
    assert.equal(pr.code, 'gh-missing')
    assert.equal(pr.recoverable, true)
    ok('缺 gh → gh-missing，可恢复且带安装指引')
  }

  // 6. gh 未登录
  {
    const gh = {
      run: async (_cwd, args) => {
        if (args[0] === '--version') return { ok: true, stdout: 'gh version 2.40.0', stderr: '' }
        return { ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts.', error: 'not logged in' }
      }
    }
    const adapter = new ReviewGitAdapter({ gitExec: fakeExec(), ghExec: gh, confirm: { confirm: async () => true } })
    const status = await adapter.ghStatus('/repo')
    assert.equal(status.installed, true)
    assert.equal(status.authenticated, false)
    const pr = await adapter.createPullRequest({ cwd: '/repo', base: 'main', head: 'feat', title: 'T', body: 'B', draft: false, remote: null })
    assert.equal(pr.ok, false)
    assert.equal(pr.code, 'gh-not-authenticated')
    assert.equal(pr.recoverable, true)
    ok('gh 未登录 → gh-not-authenticated，可恢复且带登录指引')
  }

  // 7. PR 成功：参数数组、确认目标、URL 解析
  {
    let ghCalls = []
    const gh = {
      run: async (_cwd, args) => {
        ghCalls.push(args)
        if (args[0] === '--version') return { ok: true, stdout: 'gh version 2.40.0', stderr: '' }
        if (args[0] === 'auth') return { ok: true, stdout: 'Logged in to github.com', stderr: '' }
        return { ok: true, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' }
      }
    }
    const requests = []
    const adapter = new ReviewGitAdapter({
      gitExec: fakeExec(),
      ghExec: gh,
      confirm: { confirm: async (r) => (requests.push(r), true) }
    })
    const res = await adapter.createPullRequest({
      cwd: '/repo',
      base: 'main',
      head: 'feat/x',
      title: '修复: 兼容旧 token; 以及更多',
      body: '正文',
      draft: true,
      remote: 'o/r'
    })
    assert.equal(res.ok, true)
    assert.equal(res.url, 'https://github.com/o/r/pull/7')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].action, 'create-pr')
    assert.equal(requests[0].draft, true)
    assert.equal(requests[0].base, 'main')
    const createArgs = ghCalls.find((a) => a[0] === 'pr')
    assert.ok(createArgs)
    assert.equal(createArgs[0], 'pr')
    assert.equal(createArgs[1], 'create')
    // 标题含空格 / 分号，必须仍是单个元素
    const titleIndex = createArgs.indexOf('--title')
    assert.equal(createArgs[titleIndex + 1], '修复: 兼容旧 token; 以及更多')
    assert.ok(createArgs.includes('--draft'))
    assert.equal(createArgs[createArgs.indexOf('--base') + 1], 'main')
    assert.equal(createArgs[createArgs.indexOf('--repo') + 1], 'o/r')
    ok('PR 成功：argv 数组正确、标题 / 正文不拆词，确认请求含 draft/base')
  }

  // 8. PR 未确认：认证通过后仍然不发 gh pr create
  {
    const ghCalls = []
    const gh = {
      run: async (_cwd, args) => {
        ghCalls.push(args)
        if (args[0] === '--version') return { ok: true, stdout: 'gh version 2.40.0', stderr: '' }
        if (args[0] === 'auth') return { ok: true, stdout: 'ok', stderr: '' }
        return { ok: true, stdout: 'https://github.com/o/r/pull/8', stderr: '' }
      }
    }
    const adapter = new ReviewGitAdapter({ gitExec: fakeExec(), ghExec: gh, confirm: { confirm: async () => false } })
    const res = await adapter.createPullRequest({ cwd: '/repo', base: 'main', head: 'feat', title: 'T', body: 'B', draft: false, remote: null })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not-confirmed')
    assert.equal(ghCalls.some((a) => a[0] === 'pr'), false)
    ok('PR 未确认时不调用 gh pr create')
  }

  // 9. PR 本地校验
  {
    const adapter = new ReviewGitAdapter({ gitExec: fakeExec(), ghExec: fakeExec(), confirm: { confirm: async () => true } })
    const res = await adapter.createPullRequest({ cwd: '/repo', base: '', head: 'f', title: 'T', body: 'B', draft: false, remote: null })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'invalid-input')
    ok('缺目标分支时本地拦下，不进入 gh 流程')
  }

  console.log('\n评审 Git 适配：全部通过')
} finally {
  await rm(outDir, { recursive: true, force: true })
}
