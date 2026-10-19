import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runFileContentSearchTests(ok, { searchFileContents }) {
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

    const lineHit = await searchFileContents({ ...context, requestId: 'c1', query: 'lintarget' })
    ok(lineHit.status === 'ok' && lineHit.hits.length === 1, '内容搜索命中单个文本行')
    const hit = lineHit.hits[0]
    ok(hit && hit.path === 'notes.txt' && hit.name === 'notes.txt', '内容搜索返回相对路径与文件名')
    ok(hit && hit.line === 2 && hit.text === 'lintarget here', '内容搜索行号从 1 起且文本正确')
    ok(lineHit.request.requestId === 'c1' && lineHit.request.cwd === root, '内容搜索回显请求身份与 cwd')

    const caseHit = await searchFileContents({ ...context, requestId: 'c2', query: 'mixedcase' })
    ok(caseHit.status === 'ok' && caseHit.hits.some((h) => h.path === 'src/case.md'), '内容搜索大小写不敏感')

    const skipHit = await searchFileContents({ ...context, requestId: 'c3', query: 'skiptarget' })
    ok(skipHit.status === 'empty' && skipHit.hits.length === 0, '内容搜索跳过 node_modules 与 .git')

    const dotHit = await searchFileContents({ ...context, requestId: 'c4', query: 'dottarget' })
    ok(dotHit.hits.some((h) => h.path === '.hidden/dot.txt'), '内容搜索遍历点开头的目录')

    const noExt = await searchFileContents({ ...context, requestId: 'c5', query: 'noexttarget' })
    ok(noExt.status === 'empty' && noExt.hits.length === 0, '内容搜索跳过无扩展名文件')

    const binary = await searchFileContents({ ...context, requestId: 'c6', query: 'bintarget' })
    ok(binary.status === 'empty' && binary.hits.length === 0, '内容搜索跳过含 NUL 的二进制文件')
    ok(binary.skippedFiles >= 1, '内容搜索把二进制文件计入 skippedFiles')

    const capped = await searchFileContents({ ...context, requestId: 'c7', query: 'captarget', limit: 2 })
    ok(capped.hits.length === 2 && capped.truncated, '内容搜索对命中数量设上限并报告截断')

    const empty = await searchFileContents({ ...context, requestId: 'c8', query: '   ' })
    ok(empty.status === 'empty' && empty.hits.length === 0, '内容搜索空查询返回 empty')

    const escaped = await searchFileContents({ cwd: '..', projectId: 'project-test', generation: 1, requestId: 'c9', query: 'lintarget' })
    ok(escaped.status === 'invalid' && escaped.hits.length === 0, '内容搜索拒绝相对越界 cwd')
    const traversed = await searchFileContents({ ...context, cwd: `${root}/..`, requestId: 'c10', query: 'lintarget' })
    ok(traversed.status === 'invalid' && traversed.hits.length === 0, '内容搜索拒绝带 .. 的 cwd')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
