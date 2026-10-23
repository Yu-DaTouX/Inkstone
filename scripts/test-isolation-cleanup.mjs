import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (value, label) => {
  assert.ok(value, label)
  checks++
}

for (const [key, value] of Object.entries({
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
})) process.env[key] = value

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitc = (cwd, args) => git(cwd, ['-c', 'user.name=yan-test', '-c', 'user.email=yan-test@example.com', ...args])

const root = mkdtempSync(join(tmpdir(), 'yan-iso-cleanup-'))
try {
  const outfile = join(root, 'bundle.mjs')
  await build({
    stdin: {
      contents: "export * from './src/main/isolation-cleanup.ts'\nexport { discardUnusedIsolation, isolateCwdForConflict } from './src/main/session-isolation.ts'\n",
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile).href)

  const record = (name, extra = {}) => ({ worktree: join(root, name), repoRoot: root, mainCwd: root, branch: `yan/auto-${name}`, baseBranch: 'main', sessionId: '', createdAt: 0, ...extra })
  const run = async (records, runners, saved = new Set(), now = 10 * 60_000) => {
    const live = [...runners]
    const stopped = []
    const discarded = []
    const forgotten = []
    const out = await mod.discardIdleEmptyIsolations({
      records: async () => records,
      runners: () => live,
      stopRunner: async (id) => { stopped.push(id); live.splice(live.findIndex((r) => r.id === id), 1) },
      hasSavedSession: async (r) => saved.has(r.worktree),
      discard: async (r) => { discarded.push(r.worktree); return true },
      forget: async (r) => { forgotten.push(r.worktree) },
      now: () => now
    })
    return { out, stopped, discarded, forgotten }
  }
  const idle = (id, cwd, extra = {}) => ({ id, cwd, isActive: false, busy: false, messageCount: 0, ...extra })

  const a = record('a')
  let r = await run([a], [idle('r1', a.worktree)])
  ok(r.stopped.join() === 'r1' && r.discarded.length === 1 && r.forgotten.length === 1 && r.out.length === 1, '离开后的空会话：停掉实例并删除工作树和记录')
  r = await run([a], [])
  ok(r.discarded.length === 1, '实例已回收的空会话：删除工作树')
  r = await run([a], [idle('r1', a.worktree, { isActive: true })])
  ok(r.stopped.length === 0 && r.discarded.length === 0, '正在看的空会话不动')
  r = await run([a], [idle('r1', a.worktree, { busy: true })])
  ok(r.discarded.length === 0, '运行中的会话不动')
  r = await run([a], [idle('r1', a.worktree, { messageCount: 2 })])
  ok(r.stopped.length === 0 && r.discarded.length === 0, '发过消息的会话不动')
  r = await run([a], [], new Set([a.worktree]))
  ok(r.discarded.length === 0, '磁盘上已有会话文件的不动')
  r = await run([a], [idle('r1', a.worktree)], new Set(), 30_000)
  ok(r.stopped.length === 0 && r.discarded.length === 0, '刚建好不到一分钟的不动（实例可能还没登记）')

  const sessions = join(root, 'sessions')
  mkdirSync(join(sessions, '--E--repo-worktrees-yan-auto-x--'), { recursive: true })
  const x = record('yan-auto-x')
  ok(!(await mod.hasSavedSessionUnder(sessions, x)), '会话目录里没有文件：视为没用过')
  writeFileSync(join(sessions, '--E--repo-worktrees-yan-auto-x--', '2026_s1.jsonl'), '{}\n')
  ok(await mod.hasSavedSessionUnder(sessions, x), '会话目录里有 jsonl：视为用过')

  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, ['add', '-A'])
  gitc(repo, ['commit', '-q', '-m', 'init', '--no-verify'])
  const make = async () => {
    const res = await mod.isolateCwdForConflict(repo, { now: new Date(Date.now() + Math.floor(Math.random() * 1e6)) })
    ok(res.ok, '建出隔离工作树')
    return res.record
  }
  const branches = () => git(repo, ['branch', '--list', 'yan/auto-*'])

  const clean = await make()
  ok(await mod.discardUnusedIsolation(clean), '干净且没有新提交：删除成功')
  ok(!existsSync(clean.worktree) && !branches().includes(clean.branch), '工作树目录与分支都删掉了')

  const dirty = await make()
  writeFileSync(join(dirty.worktree, 'new.txt'), 'x\n')
  ok(!(await mod.discardUnusedIsolation(dirty)), '有未提交改动：不删')
  ok(existsSync(join(dirty.worktree, 'new.txt')), '未提交改动原样保留')

  const committed = await make()
  writeFileSync(join(committed.worktree, 'b.txt'), 'b\n')
  git(committed.worktree, ['add', '-A'])
  gitc(committed.worktree, ['commit', '-q', '-m', 'work', '--no-verify'])
  ok(!(await mod.discardUnusedIsolation(committed)), '有新提交：不删')
  ok(existsSync(committed.worktree) && branches().includes(committed.branch), '有提交的工作树与分支都保留')

  console.log(`isolation-cleanup: ${checks} checks passed`)
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
