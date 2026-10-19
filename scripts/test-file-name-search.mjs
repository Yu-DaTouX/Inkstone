import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function highlight(path, positions) {
  return positions.map((index) => path[index]).join('')
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-name-search-'))
  try {
    const match = await compile('src/main/file-name-match.ts', join(dir, 'match.mjs'))
    const core = await compile('src/main/file-name-search-core.ts', join(dir, 'core.mjs'))
    const candidates = await compile('src/main/file-name-candidates.ts', join(dir, 'candidates.mjs'))
    const scheduler = await compile('src/main/file-name-scheduler.ts', join(dir, 'scheduler.mjs'))

    const hit = match.matchName('fsw', 'src/main/files-watch.ts')
    assert.ok(hit)
    assert.equal(highlight('src/main/files-watch.ts', hit.positions).toLowerCase(), 'fsw')
    assert.equal(match.matchName('xyz', 'src/main/files-watch.ts'), null)
    assert.equal(match.matchName('Files', 'src/files.ts'), null)
    assert.ok(match.matchName('files', 'src/Files.ts'))
    const boundary = match.matchName('gi', 'src/main/git-inspect.ts')
    assert.deepEqual(boundary.positions, [9, 10])
    assert.deepEqual(match.matchName('gins', 'src/main/git-inspect.ts').positions, [9, 13, 14, 15])
    const ranked = match.rankNames('index', ['src/main/index.ts', 'src/renderer/src/features/indexing/x.ts', 'docs/i-n-d-e-x.md'], (p) => p, 3)
    assert.equal(ranked[0].path, 'src/main/index.ts')
    assert.equal(match.normalizeQuery(' a b\\c '), 'ab/c')
    const camel = match.matchName('TP', 'src/TerminalPane.tsx')
    assert.deepEqual(camel.positions, [4, 12])

    const set = candidates.withParentDirs(['src/main/index.ts', 'src/main/files.ts', 'README.md'])
    assert.deepEqual(set.filter((c) => c.directory).map((c) => c.path).sort(), ['src', 'src/main'])
    assert.deepEqual(candidates.parseLsFiles('a\0b\0a\0c\0', 2), { files: ['a', 'b'], truncated: true })

    const browse = core.searchCandidates(set, '', 3)
    assert.equal(browse.matches[0].path, 'src')
    assert.equal(browse.matches[0].directory, true)
    assert.equal(browse.truncated, true)
    const dirsOnly = core.searchCandidates(set, 'main/', 10)
    assert.deepEqual(dirsOnly.matches.map((m) => m.path), ['src/main'])
    const files = core.searchCandidates(set, 'idx', 10)
    assert.equal(files.matches[0].path, 'src/main/index.ts')
    assert.equal(files.matches[0].name, 'index.ts')
    assert.equal(highlight(files.matches[0].path, files.matches[0].positions), 'idx')
    assert.equal(core.searchCandidates(set, 'q', 500).matches.length <= core.MAX_NAME_RESULTS, true)

    const repo = join(dir, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(repo, 'src', 'tracked.ts'), 'x')
    writeFileSync(join(repo, 'src', 'untracked.ts'), 'x')
    writeFileSync(join(repo, 'ignored.log'), 'x')
    writeFileSync(join(repo, '.gitignore'), '*.log\nnode_modules/\n')
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'x')
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['add', 'src/tracked.ts', '.gitignore'], { cwd: repo, stdio: 'ignore' })
    const fromGit = await candidates.collectCandidates(repo)
    assert.equal(fromGit.source, 'git')
    const gitPaths = fromGit.candidates.map((c) => c.path)
    assert.ok(gitPaths.includes('src/tracked.ts'))
    assert.ok(gitPaths.includes('src/untracked.ts'))
    assert.ok(!gitPaths.includes('ignored.log'))
    assert.ok(!gitPaths.some((p) => p.startsWith('node_modules')))

    const plain = join(dir, 'plain')
    mkdirSync(join(plain, 'a', 'b'), { recursive: true })
    mkdirSync(join(plain, 'node_modules'), { recursive: true })
    writeFileSync(join(plain, 'a', 'b', 'deep.txt'), 'x')
    writeFileSync(join(plain, 'node_modules', 'skip.js'), 'x')
    const walked = await candidates.collectCandidates(plain)
    assert.equal(walked.source, 'walk')
    assert.deepEqual(walked.candidates.map((c) => c.path).sort(), ['a', 'a/b', 'a/b/deep.txt'])

    const log = []
    const runner = (job, signal) => new Promise((resolve, reject) => {
      log.push(`start:${job.name}`)
      const timer = setTimeout(() => resolve(job.name), job.ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        log.push(`abort:${job.name}:${signal.reason}`)
        reject(new Error('aborted'))
      })
    })
    const sched = new scheduler.LatestPerScopeScheduler(runner, { concurrency: 2, queueLimit: 2, deadlineMs: 200 })
    const first = sched.submit('s1', { name: 'a1', ms: 50 })
    const second = sched.submit('s1', { name: 'a2', ms: 10 })
    assert.deepEqual(await first, { ok: false, code: 'superseded' })
    assert.deepEqual(await second, { ok: true, value: 'a2' })
    assert.ok(log.includes('abort:a1:superseded'))

    const slow = sched.submit('t', { name: 'slow', ms: 1000 })
    assert.deepEqual(await slow, { ok: false, code: 'timeout' })
    assert.ok(log.includes('abort:slow:timeout'))

    const p1 = sched.submit('c1', { name: 'c1', ms: 40 })
    const p2 = sched.submit('c2', { name: 'c2', ms: 40 })
    const p3 = sched.submit('c3', { name: 'c3', ms: 10 })
    const p4 = sched.submit('c4', { name: 'c4', ms: 10 })
    const p5 = sched.submit('c5', { name: 'c5', ms: 10 })
    assert.deepEqual(sched.stats(), { running: 2, queued: 2 })
    assert.deepEqual(await p5, { ok: false, code: 'busy' })
    const p3b = sched.submit('c3', { name: 'c3b', ms: 10 })
    assert.deepEqual(await p3, { ok: false, code: 'superseded' })
    assert.equal(log.includes('start:c3'), false)
    const results = await Promise.all([p1, p2, p4, p3b])
    assert.deepEqual(results.map((r) => r.value), ['c1', 'c2', 'c4', 'c3b'])
    await delay(5)
    assert.deepEqual(sched.stats(), { running: 0, queued: 0 })

    const failing = new scheduler.LatestPerScopeScheduler(() => { throw new Error('nope') })
    const failed = await failing.submit('x', {})
    assert.equal(failed.code, 'failed')
    assert.equal(failed.message, 'nope')

    console.log('test-file-name-search: 全部通过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
