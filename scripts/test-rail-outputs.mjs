import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function load(rel) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const rail = await load('../src/renderer/src/features/workbench/rail-data.ts')
const { outputCandidates, visibleOutputs, screenState, isScratchOutput, parseDismissed, addDismissed, dismissedStorageKey } = rail

const CWD = 'E:/work/app'
let seq = 0
const diff = (path, status) => ({ fileDiff: { path, status, added: 1, removed: status === 'created' ? 0 : 1, before: {}, after: {}, patch: '' } })
const call = (path, status, endedAt, extra = {}) => ({
  id: `c${++seq}`,
  name: 'write',
  args: { path },
  status: 'ok',
  details: diff(path, status),
  endedAt,
  ...extra
})
const assistant = (toolCalls, timestamp = 0) => ({ id: `m${++seq}`, role: 'assistant', text: '', toolCalls, timestamp })
const paths = (list) => list.map((item) => item.path)

{
  const messages = [
    assistant([
      call('E:/work/app/docs/new.md', 'created', 100),
      call('E:/work/app/src/existing.ts', 'modified', 110),
      call('E:/work/app/gone.md', 'created', 120),
      call('E:/work/app/later.md', 'created', 300)
    ]),
    assistant([call('E:/work/app/gone.md', 'deleted', 130), call('E:/work/app/docs/new.md', 'modified', 200)])
  ]
  assert.deepEqual(paths(outputCandidates(messages, CWD)), ['E:/work/app/later.md', 'E:/work/app/docs/new.md'], '只收本会话新建且仍在的文件，按时间最新在前')
}

{
  const excluded = [
    'E:/work/app/.tmp/probe.json',
    'E:/work/app/.local-docs/STATUS.md',
    'E:/work/app/node_modules/x/index.js',
    'E:/work/app/packages/a/node_modules/y.js',
    'E:/work/app/.git/COMMIT_EDITMSG',
    'E:/work/app/out/main.js',
    'E:/work/app/dist/app.js',
    'E:/work/app/build/icon.png',
    'E:/work/app/release/setup.exe',
    'E:/work/app/.claude/settings.local.json',
    'E:/work/app/debug.log',
    'E:/work/app/package-lock.json',
    'E:/work/app/pnpm-lock.yaml',
    'E:/work/app/yarn.lock',
    'E:/work/app/Cargo.lock',
    'C:/Users/me/AppData/Local/Temp/claude/abc/scratchpad/notes.md',
    'C:\\Users\\me\\AppData\\Local\\Temp\\draft.txt',
    '/tmp/scratch.txt',
    '/private/var/folders/xy/T/file.txt',
    'C:/Users/me/.claude/plans/plan.md',
    'D:/elsewhere/scratchpad/a.md'
  ]
  for (const path of excluded) assert.equal(isScratchOutput(path, CWD), true, `排除 ${path}`)
  const kept = [
    'E:/work/app/docs/report.md',
    'E:\\work\\app\\src\\feature.ts',
    'docs/relative.md',
    'D:/notes/summary.md',
    'D:/elsewhere/dist/bundle.js'
  ]
  for (const path of kept) assert.equal(isScratchOutput(path, CWD), false, `保留 ${path}`)
  const worktree = 'E:/repo/.claude/worktrees/topic'
  assert.equal(isScratchOutput('E:/repo/.claude/worktrees/topic/src/a.ts', worktree), false, 'cwd 本身在 .claude 下时只看 cwd 以内的相对路径')
  assert.equal(isScratchOutput('E:/repo/.claude/worktrees/topic/.claude/x.md', worktree), true)
  assert.equal(isScratchOutput('/tmp/project/a.md', '/tmp/project'), false, 'cwd 在临时目录时其中的文件保留')
  assert.equal(isScratchOutput('/tmp/elsewhere.md', '/home/me/project'), true)
}

{
  const messages = [
    assistant([
      call('E:/work/app/a.md', 'created', undefined),
      call('E:/work/app/b.md', 'created', undefined),
      call('E:/work/app/.tmp/c.md', 'created', 999),
      call('E:/work/app/node_modules/d.js', 'created', 999),
      { id: 'run', name: 'bash', status: 'ok', args: { command: 'node tool.mjs --request-file E:/work/app/req.json' } },
      call('E:/work/app/req.json', 'created', 50)
    ])
  ]
  assert.deepEqual(paths(outputCandidates(messages, CWD)), ['E:/work/app/b.md', 'E:/work/app/a.md'], '无时间戳时按出现顺序倒序；请求文件与草稿目录排除')
  assert.deepEqual(outputCandidates([], CWD), [])
  assert.deepEqual(paths(outputCandidates([assistant([call('C:/Users/me/AppData/Local/Temp/x.md', 'created', 5), call('D:/notes/n.md', 'created', 6)])], CWD)), ['D:/notes/n.md'], 'cwd 以外保留，临时目录排除')
}

{
  const pool = [
    { path: 'a.md', at: 3 },
    { path: 'b.md', at: 2 },
    { path: 'c.md', at: 1 },
    { path: 'd.md', at: 0 }
  ]
  assert.deepEqual(paths(visibleOutputs(pool, null, [])), ['a.md', 'b.md', 'c.md', 'd.md'], '非 git 或无桥时不过滤')
  assert.deepEqual(paths(visibleOutputs(pool, null, ['b.md'])), ['a.md', 'c.md', 'd.md'], '手动移除的条目不显示')
  const done = screenState(['a.md', 'b.md', 'c.md', 'd.md'], { ignored: ['c.md'], missing: ['d.md'] }, false)
  assert.deepEqual(paths(visibleOutputs(pool, done, [])), ['a.md', 'b.md'], 'git 忽略与已不存在的文件不显示')
  const pending = screenState(['a.md', 'b.md'], { ignored: [], missing: [] }, true)
  assert.deepEqual(paths(visibleOutputs(pool, pending, [])), ['a.md', 'b.md'], '筛查进行中时未筛过的新条目先不显示')
  const failed = screenState(['a.md', 'b.md', 'c.md', 'd.md'], { ignored: [], missing: [] }, false)
  assert.equal(visibleOutputs(pool, failed, []).length, 4, '筛查失败时不过滤')
}

{
  assert.ok(dismissedStorageKey('sess-1').endsWith('sess-1'), '移除记录按会话 id 分开')
  assert.notEqual(dismissedStorageKey('a'), dismissedStorageKey('b'))
  assert.deepEqual(parseDismissed(null), [])
  assert.deepEqual(parseDismissed('not json'), [])
  assert.deepEqual(parseDismissed(JSON.stringify(['a', 3, 'b'])), ['a', 'b'])
  assert.deepEqual(addDismissed(['a', 'b'], 'a'), ['b', 'a'])
  assert.equal(addDismissed(Array.from({ length: 250 }, (_, i) => `f${i}`), 'new').length, 200)
}

const screenModule = await load('../src/main/git-path-screen.ts')
const work = await mkdtemp(join(tmpdir(), 'inkstone-rail-outputs-'))
try {
  const repo = join(work, 'repo')
  const plain = join(work, 'plain')
  execFileSync('git', ['init', '-q', repo])
  await mkdir(plain, { recursive: true })
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\ngen/\n')
  await writeFile(join(repo, 'ignored.txt'), 'x')
  await writeFile(join(repo, 'kept.txt'), 'x')
  await mkdir(join(repo, 'gen'), { recursive: true })
  await writeFile(join(repo, 'gen', 'out.md'), 'x')
  await writeFile(join(plain, 'note.md'), 'x')
  await writeFile(join(work, 'outside.md'), 'x')
  const outside = join(work, 'outside.md')
  const screened = await screenModule.screenPaths(repo, ['ignored.txt', 'kept.txt', 'missing.txt', join(repo, 'gen', 'out.md'), outside])
  assert.deepEqual([...screened.ignored].sort(), [join(repo, 'gen', 'out.md'), 'ignored.txt'].sort(), '一次 git check-ignore 批量标出忽略文件')
  assert.deepEqual(screened.missing, ['missing.txt'], '不存在的文件单独标出')
  const nonGit = await screenModule.screenPaths(plain, ['note.md', 'gone.md'])
  assert.deepEqual(nonGit, { ignored: [], missing: ['gone.md'] }, '非 git 目录不按忽略过滤')
} finally {
  await rm(work, { recursive: true, force: true })
}

const ipc = await readFile(new URL('../src/main/ipc/git-ipc.ts', import.meta.url), 'utf8')
const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const shared = await readFile(new URL('../src/shared/ipc.ts', import.meta.url), 'utf8')
assert.ok(ipc.includes("'yan:git:screenPaths'"), '主进程注册 yan:git:screenPaths')
assert.ok(preload.includes("'yan:git:screenPaths'"), 'preload 暴露 screenPaths')
assert.ok(/screenPaths\(cwd: string, paths: string\[\]\)/.test(shared), 'GitBridge 声明 screenPaths')

console.log('rail-outputs ok')
