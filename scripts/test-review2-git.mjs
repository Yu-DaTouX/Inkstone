import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-review2-git-'))
try {
  const modules = join(temp, 'modules')
  await mkdir(modules)
  for (const [source, output] of [
    ['src/main/git-service.ts', 'git-service.mjs'],
    ['src/main/work-mode-service.ts', 'work-mode-service.mjs'],
    ['src/main/subagent-isolation.ts', 'subagent-isolation.mjs'],
    ['src/main/git-actions.ts', 'git-actions.mjs']
  ]) {
    await build({ entryPoints: [source], outfile: join(modules, output), bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  }
  const load = (name) => import(pathToFileURL(join(modules, name)).href)
  const git = await load('git-service.mjs')
  const large = join(temp, 'large.log')
  const prefix = Buffer.from('line one\nline two\n')
  const handle = await import('node:fs/promises').then(({ open }) => open(large, 'w'))
  try {
    await handle.write(prefix, 0, prefix.length, 0)
    await handle.truncate(8 * 1024 * 1024)
  } finally { await handle.close() }
  const before = process.memoryUsage().arrayBuffers
  const metadata = await git.readUntrackedMeta(large)
  assert.equal(metadata.truncated, true)
  assert.equal(metadata.lines, 3, '截断缓冲区末尾的稀疏零填充仍按最后一行计数')
  assert.equal(metadata.size, (await stat(large)).size)
  assert.ok(process.memoryUsage().arrayBuffers - before < 2 * 1024 * 1024, '只读取有界前缀而非整个大文件')

  const modes = await load('work-mode-service.mjs')
  const store = new modes.WorkModeStore({ root: join(temp, 'settings') })
  await store.load()
  store.persist = async () => { throw new Error('fixture write failure') }
  await assert.rejects(store.set('session-a', 'autonomous'))
  assert.equal(store.state('session-a').revision, 0, '写盘失败回滚未落盘的模式变更')
  assert.deepEqual(store.snapshot().entries, {})

  const isolation = await load('subagent-isolation.mjs')
  const rename = isolation.summarizeGitDiff('R100\told-name.txt\tnew-name.txt\nM\tkeep.txt\n', '1\t0\tnew-name.txt\n')
  assert.deepEqual(rename.paths, ['new-name.txt', 'keep.txt'], '重命名摘要指向新路径')

  const actions = await load('git-actions.mjs')
  const missingCwd = await actions.runGitAction({ kind: 'stage-all', requestId: 'r', cwd: '', expected: {} })
  assert.equal(missingCwd.ok, false)
  assert.equal(missingCwd.failure.code, 'invalid-input')

  console.log('review2 git behavioral regression passed')
} finally {
  await rm(temp, { recursive: true, force: true })
}
