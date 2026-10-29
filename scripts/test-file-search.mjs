import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleForTest } from './lib/file-search-test-bundle.mjs'

const highlight = (path, positions) => positions.map((index) => path[index]).join('')

const nameSearch = await bundleForTest('src/main/file-name-search.ts', 'file-name-search.mjs')
const contentSearch = await bundleForTest('src/main/file-content-search.ts', 'file-content-search.mjs')
const match = await bundleForTest('src/main/file-name-match.ts', 'file-name-match.mjs')
const index = await bundleForTest('src/main/file-search-index.ts', 'file-search-index.mjs')
const schedulerModule = await bundleForTest('src/main/file-name-scheduler.ts', 'file-name-scheduler.mjs')

const dir = mkdtempSync(join(tmpdir(), 'inkstone-file-search-'))

function write(root, rel, text) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
}

function search(root, query, extra = {}) {
  return nameSearch.searchFileNames('scope', {
    cwd: root,
    projectId: 'project-test',
    generation: 1,
    requestId: `r-${query}`,
    query,
    ...extra
  })
}

async function runNameTests(repo) {
  const first = await search(repo, 'index')
  assert.equal(first.matches[0]?.path, 'src/main/index.ts', '文件名搜索按模糊匹配返回最相关路径')
  assert.equal(first.matches[0].name, 'index.ts')
  assert.equal(first.matches[0].directory, false)
  assert.equal(highlight('src/main/index.ts', first.matches[0].positions).toLowerCase(), 'index', '返回用于高亮的字符位置')
  assert.equal(first.source, 'git', 'git 仓库里报告 git 索引来源')
  assert.ok(first.scanned >= 6, '报告索引里的文件数')

  const fuzzy = await search(repo, 'flsw')
  assert.ok(fuzzy.matches.some((entry) => entry.path === 'src/main/files-watch.ts'), '模糊匹配容忍缺字母')

  const ignored = await search(repo, 'ignored.log')
  assert.equal(ignored.matches.some((entry) => entry.path.endsWith('.log')), false, '.gitignore 里的文件不进索引')

  const modules = await search(repo, 'dep')
  assert.equal(modules.matches.some((entry) => entry.path.startsWith('node_modules')), false, 'node_modules 不进索引')

  const hidden = await search(repo, 'dot')
  assert.ok(hidden.matches.some((entry) => entry.path === '.hidden/dot.txt'), 'git 仓库里的点目录会被索引')

  const limited = await search(repo, 'ts', { limit: 3 })
  assert.ok(limited.matches.length <= 3, '结果数量受 limit 限制')
  assert.equal(limited.truncated, true, '还有更多命中时报告截断')

  const cap = await search(repo, 'ts', { limit: 1000 })
  assert.ok(cap.matches.length <= 50, 'limit 不超过 MAX_NAME_RESULTS')

  const dirs = await search(repo, 'main/')
  assert.equal(dirs.matches[0]?.path, 'src/main', '斜杠结尾只返回目录')
  assert.ok(dirs.matches.every((entry) => entry.directory), '斜杠结尾全部是目录')
  assert.equal(dirs.matches[0].directory, true)
  assert.equal(highlight('src/main', dirs.matches[0].positions).toLowerCase(), 'main')

  const missing = await search(join(repo, 'nope'), 'index')
  assert.equal(missing.error?.code, 'invalid', '不存在的 cwd 返回 invalid')
  assert.equal(missing.matches.length, 0)

  const plain = mkdtempSync(join(tmpdir(), 'inkstone-file-search-plain-'))
  write(plain, 'a/b/deep.txt', 'deep')
  write(plain, '.hidden/dot.txt', 'dottarget')
  const walked = await search(plain, 'deep')
  assert.equal(walked.source, 'walk', '非 git 目录报告 walk 来源')
  assert.equal(walked.matches[0]?.path, 'a/b/deep.txt')
  assert.equal(walked.matches.some((entry) => entry.path.startsWith('.hidden')), false, '非 git 目录不索引点开头的文件')
  rmSync(plain, { recursive: true, force: true })
}

async function runContentTests(repo) {
  const request = (query, extra = {}) => ({
    cwd: repo,
    projectId: 'project-test',
    generation: 1,
    requestId: `c-${query}`,
    query,
    ...extra
  })
  const found = await contentSearch.searchFileContents(request('lintarget'))
  assert.equal(found.status, 'ok')
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].path, 'notes.txt')
  assert.equal(found.hits[0].line, 2)
  assert.equal(found.hits[0].text, 'lintarget here')
  assert.deepEqual(found.hits[0].ranges, [[0, 9]])
  assert.equal(found.hits[0].column, 1)
  assert.ok(found.scannedFiles >= 1)

  const cjk = await contentSearch.searchFileContents(request('中文目标'))
  assert.equal(cjk.hits[0]?.path, 'src/cjk.md', '非 ASCII 行也能命中')
  const cjk2 = await contentSearch.searchFileContents(request('foo'))
  const cjkHit = cjk2.hits.find((entry) => entry.path === 'src/cjk2.md')
  assert.ok(cjkHit, '非 ASCII 行里的 ASCII 关键词能命中')
  assert.deepEqual(cjkHit.ranges, [[6, 9]], '返回字符区间而不是原生引擎的字节区间')

  const ignored = await contentSearch.searchFileContents(request('ignoredtarget'))
  assert.equal(ignored.hits.length, 0, '内容搜索遵守 .gitignore')

  const modules = await contentSearch.searchFileContents(request('nodetarget'))
  assert.equal(modules.hits.length, 0, '内容搜索跳过 node_modules')

  const binary = await contentSearch.searchFileContents(request('bintarget'))
  assert.equal(binary.hits.length, 0, '内容搜索跳过二进制文件')
  assert.ok(binary.skippedFiles >= 1, '二进制文件计入 skippedFiles')

  const cased = await contentSearch.searchFileContents(request('LINTARGET', { matchCase: true }))
  assert.equal(cased.hits.length, 0, '区分大小写时忽略大小写不一致的行')
  const casedExact = await contentSearch.searchFileContents(request('lintarget', { matchCase: true }))
  assert.equal(casedExact.hits.length, 1, '区分大小写时命中大小写一致的文本')
  const lowered = await contentSearch.searchFileContents(request('LINTARGET', { matchCase: false }))
  assert.equal(lowered.hits.length, 1, '不区分大小写时大写查询也能命中')

  const whole = await contentSearch.searchFileContents(request('foobar', { wholeWord: true }))
  const wholeLine = whole.hits.find((entry) => entry.path === 'opts.ts')
  assert.ok(wholeLine && wholeLine.text.slice(wholeLine.ranges[0][0], wholeLine.ranges[0][1]) === 'foobar', '全字匹配返回整词区间')
  const partial = await contentSearch.searchFileContents(request('foob', { wholeWord: true }))
  assert.equal(partial.hits.filter((entry) => entry.path === 'opts.ts').length, 0, '全字匹配不接受词的一部分')

  const regex = await contentSearch.searchFileContents(request('foo\\(\\w+\\)', { regexp: true }))
  assert.ok(regex.hits.some((entry) => entry.path === 'opts.ts' && entry.line === 2 && JSON.stringify(entry.ranges) === JSON.stringify([[0, 8]])), '正则模式按正则匹配')

  const lookahead = await contentSearch.searchFileContents(request('foo(?=_)', { regexp: true }))
  assert.equal(lookahead.status, 'pattern', '原生正则不支持 look-around 时报 pattern 而不是给错结果')

  const capped = await contentSearch.searchFileContents(request('foobar', { limit: 1 }))
  assert.equal(capped.hits.length, 1)
  assert.ok(capped.truncated && capped.truncation.includes('result-limit'), '命中上限时报告 result-limit')

  const aborted = new AbortController()
  aborted.abort('superseded')
  const cancelled = await contentSearch.searchFileContents(request('lintarget'), { signal: aborted.signal })
  assert.equal(cancelled.status, 'cancelled')

  const missing = await contentSearch.searchFileContents({ ...request('lintarget'), cwd: join(repo, 'nope') })
  assert.equal(missing.status, 'missing')
}

async function runIndexTests() {
  const roots = []
  for (let n = 0; n < 5; n += 1) {
    const root = mkdtempSync(join(tmpdir(), `inkstone-index-${n}-`))
    write(root, `only${n}.marker`, 'marker')
    roots.push(root)
  }
  for (const [n, root] of roots.entries()) {
    const page = await index.runNameJob({ root, query: `marker`, limit: 10, directoriesOnly: false })
    assert.ok(page.hits.some((hit) => hit.path === `only${n}.marker`), '多项目索引都能查询')
  }
  const reopened = await index.runNameJob({ root: roots[0], query: 'marker', limit: 10, directoriesOnly: false })
  assert.ok(reopened.hits.some((hit) => hit.path === 'only0.marker'), '被淘汰的项目再次查询能重新建索引')
  index.closeAllIndexes()
  const afterClose = await index.runGrepJob({
    root: roots[0],
    query: 'marker',
    mode: 'plain',
    smartCase: true,
    maxFileSize: 1_048_576,
    pageSize: 50,
    maxMatchesPerFile: 200,
    timeBudgetMs: 5000,
    cursor: null
  })
  assert.ok(afterClose.lines.some((line) => line.path === 'only0.marker'), '释放索引后还能重新打开')
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

function runMatcherTests() {
  const hit = match.matchName('fsw', 'src/main/files-watch.ts')
  assert.ok(hit)
  assert.equal(highlight('src/main/files-watch.ts', hit.positions).toLowerCase(), 'fsw')
  assert.equal(match.matchName('xyz', 'src/main/files-watch.ts'), null)
  assert.equal(match.matchName('Files', 'src/files.ts'), null)
  assert.ok(match.matchName('files', 'src/Files.ts'))
  assert.deepEqual(match.matchName('gi', 'src/main/git-inspect.ts').positions, [9, 10])
  assert.deepEqual(match.matchName('gins', 'src/main/git-inspect.ts').positions, [9, 13, 14, 15])
  assert.deepEqual(match.matchName('TP', 'src/TerminalPane.tsx').positions, [4, 12])
  assert.equal(match.normalizeQuery(' a b\\c '), 'ab/c')
}

async function runSchedulerTests() {
  const { LatestPerScopeScheduler } = schedulerModule
  const log = []
  const runner = (job, signal) =>
    new Promise((resolve, reject) => {
      log.push(`start:${job.name}`)
      const timer = setTimeout(() => resolve(job.name), job.ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        log.push(`abort:${job.name}:${signal.reason}`)
        reject(new Error('aborted'))
      })
    })
  const scheduler = new LatestPerScopeScheduler(runner, { concurrency: 2, queueLimit: 2, deadlineMs: 200 })
  const first = scheduler.submit('s1', { name: 'a1', ms: 50 })
  const second = scheduler.submit('s1', { name: 'a2', ms: 10 })
  assert.deepEqual(await first, { ok: false, code: 'superseded' })
  assert.deepEqual(await second, { ok: true, value: 'a2' })
  assert.ok(log.includes('abort:a1:superseded'), '同 scope 的新请求把旧请求置为 superseded')

  const slow = scheduler.submit('t', { name: 'slow', ms: 1000 })
  assert.deepEqual(await slow, { ok: false, code: 'timeout' }, '超过期限返回 timeout')
  assert.ok(log.includes('abort:slow:timeout'))

  const p1 = scheduler.submit('c1', { name: 'c1', ms: 40 })
  const p2 = scheduler.submit('c2', { name: 'c2', ms: 40 })
  const p3 = scheduler.submit('c3', { name: 'c3', ms: 10 })
  const p4 = scheduler.submit('c4', { name: 'c4', ms: 10 })
  const p5 = scheduler.submit('c5', { name: 'c5', ms: 10 })
  assert.deepEqual(scheduler.stats(), { running: 2, queued: 2 })
  assert.deepEqual(await p5, { ok: false, code: 'busy' }, '队列满了返回 busy')
  const p3b = scheduler.submit('c3', { name: 'c3b', ms: 10 })
  assert.deepEqual(await p3, { ok: false, code: 'superseded' })
  assert.equal(log.includes('start:c3'), false, '被顶掉的排队请求不会启动')
  const results = await Promise.all([p1, p2, p4, p3b])
  assert.deepEqual(results.map((r) => r.value), ['c1', 'c2', 'c4', 'c3b'])
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(scheduler.stats(), { running: 0, queued: 0 })

  const failing = new LatestPerScopeScheduler(() => {
    throw new Error('nope')
  })
  const failed = await failing.submit('x', {})
  assert.equal(failed.code, 'failed')
  assert.equal(failed.message, 'nope')

  const disposing = new LatestPerScopeScheduler(() => new Promise(() => {}))
  const stuck = disposing.submit('d', {})
  disposing.dispose()
  assert.deepEqual(await stuck, { ok: false, code: 'failed', message: 'disposed' }, '释放时挂住的请求以 failed/disposed 结束')
}

try {
  const repo = join(dir, 'repo')
  write(repo, '.gitignore', '*.log\nnode_modules/\n')
  write(repo, 'src/tracked.ts', 'tracked')
  write(repo, 'src/untracked.ts', 'untracked')
  write(repo, 'src/helper.ts', 'helper')
  write(repo, 'src/main/index.ts', 'index')
  write(repo, 'src/main/files-watch.ts', 'watch')
  write(repo, 'docs/readme.md', 'readme')
  write(repo, 'notes.txt', 'alpha\nlintarget here\nomega\n')
  write(repo, 'src/cjk.md', '中文目标 行\n')
  write(repo, 'src/cjk2.md', '中文命中行 foo\n')
  write(repo, 'opts.ts', 'const Foo = foo_bar + foobar\nfoo(Foo)\n')
  write(repo, 'ignored.log', 'ignoredtarget')
  write(repo, 'blob.txt', Buffer.from('bintarget\0tail', 'utf8'))
  write(repo, 'node_modules/dep/index.js', 'nodetarget')
  write(repo, '.hidden/dot.txt', 'dottarget')
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['add', 'src/tracked.ts', '.gitignore'], { cwd: repo, stdio: 'ignore' })

  runMatcherTests()
  await runSchedulerTests()
  await runNameTests(repo)
  await runContentTests(repo)
  await runIndexTests()
  console.log('test-file-search: 全部通过')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
