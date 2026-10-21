import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runFileContentSearchTests(ok, { searchFileContents, compileContentMatcher, matchContentLines }) {
  const localMatch = async (job) => {
    const matcher = compileContentMatcher(job.query, job.options)
    if (!matcher) throw new Error('pattern')
    return matchContentLines(matcher, job.texts, job.limit)
  }
  const search = (request, extra = {}) => searchFileContents(request, { match: localMatch, ...extra })
  const root = await mkdtemp(join(tmpdir(), 'yan-content-search-'))
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    await mkdir(join(root, '.hidden'), { recursive: true })

    await writeFile(join(root, 'notes.txt'), 'alpha\nlintarget here\nomega\n')
    await writeFile(join(root, 'src', 'case.md'), 'MiXeDcAsE value\n')
    await writeFile(join(root, 'node_modules', 'pkg', 'skip.txt'), 'skiptarget\n')
    await writeFile(join(root, '.git', 'objects', 'skip.txt'), 'skiptarget\n')
    await writeFile(join(root, '.hidden', 'dot.txt'), 'dottarget\n')
    await writeFile(join(root, 'LICENSE'), 'noexttarget\n')
    await writeFile(join(root, 'blob.txt'), Buffer.from('bintarget\0tail', 'utf8'))
    await writeFile(join(root, 'many.txt'), Array.from({ length: 5 }, () => 'captarget').join('\n'))

    const context = { cwd: root, projectId: 'project-test', generation: 7 }

    const lineHit = await search({ ...context, requestId: 'c1', query: 'lintarget' })
    ok(lineHit.status === 'ok' && lineHit.hits.length === 1, '内容搜索命中单个文本行')
    const hit = lineHit.hits[0]
    ok(hit && hit.path === 'notes.txt' && hit.name === 'notes.txt', '内容搜索返回相对路径与文件名')
    ok(hit && hit.line === 2 && hit.text === 'lintarget here', '内容搜索行号从 1 起且文本正确')
    ok(lineHit.request.requestId === 'c1' && lineHit.request.cwd === root, '内容搜索回显请求身份与 cwd')

    const caseHit = await search({ ...context, requestId: 'c2', query: 'mixedcase' })
    ok(caseHit.status === 'ok' && caseHit.hits.some((h) => h.path === 'src/case.md'), '内容搜索大小写不敏感')

    const skipHit = await search({ ...context, requestId: 'c3', query: 'skiptarget' })
    ok(skipHit.status === 'empty' && skipHit.hits.length === 0, '内容搜索跳过 node_modules 与 .git')

    const dotHit = await search({ ...context, requestId: 'c4', query: 'dottarget' })
    ok(dotHit.hits.some((h) => h.path === '.hidden/dot.txt'), '内容搜索遍历点开头的目录')

    const noExt = await search({ ...context, requestId: 'c5', query: 'noexttarget' })
    ok(noExt.status === 'empty' && noExt.hits.length === 0, '内容搜索跳过无扩展名文件')

    const binary = await search({ ...context, requestId: 'c6', query: 'bintarget' })
    ok(binary.status === 'empty' && binary.hits.length === 0, '内容搜索跳过含 NUL 的二进制文件')
    ok(binary.skippedFiles >= 1, '内容搜索把二进制文件计入 skippedFiles')

    const capped = await search({ ...context, requestId: 'c7', query: 'captarget', limit: 2 })
    ok(capped.hits.length === 2 && capped.truncated, '内容搜索对命中数量设上限并报告截断')

    const empty = await search({ ...context, requestId: 'c8', query: '   ' })
    ok(empty.status === 'empty' && empty.hits.length === 0, '内容搜索空查询返回 empty')

    await writeFile(join(root, 'opts.ts'), 'const Foo = foo_bar + foobar\nfoo(Foo)\n' + ' '.repeat(300) + 'deepfoo tail\n')
    const literal = await search({ ...context, requestId: 'o1', query: 'foo' })
    const literalLines = literal.hits.filter((h) => h.path === 'opts.ts')
    ok(literalLines.length === 3, '内容搜索默认不区分大小写，每个匹配行一条')
    ok(literalLines[0].column === 7 && JSON.stringify(literalLines[0].ranges) === JSON.stringify([[6, 9], [12, 15], [22, 25]]), '内容搜索返回首个匹配列号与全部匹配区间')
    ok(literalLines[2].text.length < 300 && literalLines[2].text.slice(literalLines[2].ranges[0][0], literalLines[2].ranges[0][1]) === 'foo', '长行片段从匹配前 160 字截取且区间换算正确')

    const cased = await search({ ...context, requestId: 'o2', query: 'Foo', matchCase: true })
    const casedLines = cased.hits.filter((h) => h.path === 'opts.ts')
    ok(casedLines.length === 2 && JSON.stringify(casedLines[0].ranges) === JSON.stringify([[6, 9]]), '区分大小写只命中大小写一致的文本')

    const whole = await search({ ...context, requestId: 'o3', query: 'foo', wholeWord: true })
    const wholeLines = whole.hits.filter((h) => h.path === 'opts.ts')
    ok(wholeLines.length === 2 && JSON.stringify(wholeLines[0].ranges) === JSON.stringify([[6, 9]]), '全字匹配不命中 foo_bar、foobar、deepfoo')

    const regex = await search({ ...context, requestId: 'o4', query: 'foo\\(\\w+\\)', regexp: true })
    ok(regex.hits.some((h) => h.path === 'opts.ts' && h.line === 2 && JSON.stringify(h.ranges) === JSON.stringify([[0, 8]])), '正则模式按正则匹配')

    const literalParen = await search({ ...context, requestId: 'o5', query: 'foo(' })
    ok(literalParen.status === 'ok' && literalParen.hits.some((h) => h.path === 'opts.ts' && h.line === 2), '非正则模式把特殊字符当字面量')

    const badRegex = await search({ ...context, requestId: 'o6', query: 'foo(', regexp: true })
    ok(badRegex.status === 'pattern' && badRegex.hits.length === 0, '非法正则返回 pattern 状态而不抛错')

    const emptyMatch = await search({ ...context, requestId: 'o7', query: 'x*', regexp: true })
    ok(emptyMatch.status !== 'pattern', '可匹配空串的正则不会死循环')

    const capped2 = await search({ ...context, requestId: 'o8', query: 'captarget', limit: 2 })
    ok(capped2.truncation?.includes('result-limit'), '命中上限时截断原因为 result-limit')

    const escaped = await search({ cwd: '..', projectId: 'project-test', generation: 1, requestId: 'c9', query: 'lintarget' })
    ok(escaped.status === 'invalid' && escaped.hits.length === 0, '内容搜索拒绝相对越界 cwd')
    const traversed = await search({ ...context, cwd: `${root}/..`, requestId: 'c10', query: 'lintarget' })
    ok(traversed.status === 'invalid' && traversed.hits.length === 0, '内容搜索拒绝带 .. 的 cwd')

    const aborted = new AbortController()
    aborted.abort('superseded')
    const cancelled = await search({ ...context, requestId: 'a1', query: 'lintarget' }, { signal: aborted.signal })
    ok(cancelled.status === 'cancelled' && cancelled.hits.length === 0, '内容搜索响应 AbortSignal 取消')

    const exploding = await searchFileContents(
      { ...context, requestId: 'a2', query: '(a+)+b', regexp: true },
      { match: async () => { throw new Error('timeout') } }
    )
    ok(exploding.truncation?.includes('timeout') === true, '匹配超时记为 timeout 截断而不是挂住')
    ok(exploding.hits.length === 0 && exploding.status !== 'ok', '匹配超时后不返回半截命中')

    let ticks = 0
    const expired = await search({ ...context, requestId: 'a3', query: 'lintarget' }, { now: () => (ticks += 1) * 9000 })
    ok(expired.truncation?.includes('timeout') === true, '总期限到达后按 timeout 截断')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
