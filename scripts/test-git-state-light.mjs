import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

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

function stubs(map) {
  return {
    name: 'stubs',
    setup(b) {
      for (const [id, contents] of Object.entries(map)) {
        const filter = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`)
        b.onResolve({ filter }, () => ({ path: id, namespace: 'stub' }))
      }
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ loader: 'js', contents: map[args.path], resolveDir: process.cwd() }))
    }
  }
}

const countedChildProcess = [
  "import * as real from 'child_process'",
  "export * from 'child_process'",
  'const calls = (globalThis.__gitCalls ??= [])',
  "const verb = (args) => args.filter((arg, index) => arg !== '-c' && args[index - 1] !== '-c' && !arg.startsWith('--'))[0]",
  "export function execFile(file, args, ...rest) { if (file === 'git') calls.push(verb(args)); return real.execFile(file, args, ...rest) }"
].join('\n')

await runSuite(import.meta.url, async (ok, compile) => {
  const calls = (globalThis.__gitCalls = [])
  const { registerGitIpc } = await compile(resolve('src/main/ipc/git-ipc.ts'), { plugins: [stubs({ 'node:child_process': countedChildProcess })], external: ['child_process'] })
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'yan-git-light-')))
  const previousEnv = { ...process.env }
  Object.assign(process.env, GIT_ENV)
  try {
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    git(['init', '-q', '-b', 'trunk'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(['add', 'a.txt'])
    git(['commit', '-q', '-m', 'first'])
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    writeFileSync(join(repo, 'b.txt'), 'new\n')

    const handlers = new Map()
    let allowed = true
    registerGitIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { authorizeReadCwd: async (cwd) => (allowed ? { ok: true, cwd } : { ok: false, error: 'denied' }) })
    const state = handlers.get('yan:git:state')

    const full = await state(repo)
    ok(full.repo?.branch === 'trunk' && full.repo.changedCount === 2 && !!full.expected?.statusDigest, '完整读取仍返回仓库状态与 expected')

    calls.length = 0
    const fullAgain = await state(repo)
    const fullCalls = [...calls]
    ok(fullCalls.length === 4 && fullCalls.includes('rev-parse') && fullCalls.includes('ls-files'), '完整读取起 4 个 git 进程', fullCalls.join(','))

    calls.length = 0
    const light = await state(repo, { light: true })
    const lightCalls = [...calls]
    ok(lightCalls.length === 2 && lightCalls.includes('config') && lightCalls.includes('status'), '轻量读取只起筛选守卫与 status 两个进程', lightCalls.join(','))
    ok(light.expected === undefined && JSON.stringify(light.repo) === JSON.stringify(fullAgain.repo), '轻量读取的仓库状态与完整读取逐字段相同，不带 expected')

    calls.length = 0
    const [first, second] = await Promise.all([state(repo, { light: true }), state(repo, { light: true })])
    ok(calls.length === 2 && JSON.stringify(first) === JSON.stringify(second), '同一时刻的两次轻量读取共用一次', calls.join(','))

    calls.length = 0
    const [sharedFull, sharedLight] = await Promise.all([state(repo), state(repo, { light: true })])
    ok(calls.length === 4 && JSON.stringify(sharedLight.repo) === JSON.stringify(sharedFull.repo) && sharedLight.expected === undefined, '完整读取进行中时轻量读取复用它，不另起进程', calls.join(','))

    calls.length = 0
    writeFileSync(join(repo, 'c.txt'), 'later\n')
    const fresh = await state(repo, { light: true })
    ok(fresh.repo.changedCount === 3 && calls.length === 2, '上一次结束后的轻量读取重新查询，不复用旧结果')

    allowed = false
    calls.length = 0
    const denied = await state(repo, { light: true })
    ok(denied.repo === null && !!denied.error && calls.length === 0, '未授权目录的轻量读取仍然拒绝且不起进程')

    allowed = true
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'yan-git-light-none-')))
    try {
      const none = await state(outside, { light: true })
      ok(none.repo === null && none.error === undefined, '非仓库目录的轻量读取返回空仓库且无错误')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  let statusCalls = 0
  let releaseStatus = () => undefined
  globalThis.__ghStatus = () => {
    statusCalls++
    return new Promise((done) => {
      releaseStatus = () => done({ installed: true, authed: true, repo: null, call: statusCalls })
    })
  }
  const { registerGithubIpc } = await compile(resolve('src/main/ipc/github-ipc.ts'), {
    plugins: [stubs({
      electron: 'export const shell = { openExternal: async () => {} }',
      '../settings': 'export const getSettings = async () => ({}), patchSettings = async () => ({})',
      '../project-trust': 'export const trustStatus = async () => ({ trusted: false })',
      '../collab/git': 'export const repoRootOf = async () => null, resolveCommit = async () => null',
      '../git-service': 'export const gitRun = async () => ({ ok: true })',
      '../collab/github-publish': 'export const publishPeerBranch = async () => ({ ok: false })',
      '../github/defaults': 'export const readPrCreateDefaults = async () => ({ ok: false })',
      '../github/gh': 'export const readGithubStatus = (cwd) => globalThis.__ghStatus(cwd), ghPrDetail = async () => ({}), ghPrDiff = async () => ({}), ghPrList = async () => ({})'
    })]
  })
  const handlers = new Map()
  registerGithubIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { authorizeReadCwd: async (cwd) => ({ ok: true, cwd }) })
  const status = handlers.get('yan:github:status')
  const a = status('/one')
  const b = status('/one')
  await new Promise((done) => setTimeout(done, 10))
  ok(statusCalls === 1, '同一目录进行中的 GitHub 状态探测只跑一次')
  releaseStatus()
  const [ra, rb] = await Promise.all([a, b])
  ok(ra.call === 1 && rb.call === 1, '两个调用方拿到同一次探测的结果')
  const c = status('/one')
  await new Promise((done) => setTimeout(done, 10))
  ok(statusCalls === 2, '上一次结束后重新探测，不缓存旧结果')
  const d = status('/two')
  await new Promise((done) => setTimeout(done, 10))
  ok(statusCalls === 3, '不同目录各自探测')
  releaseStatus()
  await d
  delete globalThis.__ghStatus
  void c
})
