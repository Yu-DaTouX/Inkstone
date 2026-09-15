/** L02 文件树与 N19 项目文件名搜索的 Node 级边界测试。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runFileListingTests(ok, { listDir, searchFiles }) {
  const root = await mkdtemp(join(tmpdir(), 'yan-files-'))
  try {
    await mkdir(join(root, 'src', 'main'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'ignored-package'), { recursive: true })
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Yan\n')
    await writeFile(join(root, 'src', 'main', 'agent.ts'), 'export const agent = true\n')
    await writeFile(join(root, 'src', 'main', 'agent.test.ts'), 'test\n')
    await writeFile(join(root, 'docs', 'readme.md'), '# docs\n')
    await writeFile(join(root, 'node_modules', 'ignored-package', 'agent.ts'), 'ignored\n')
    await writeFile(join(root, '.git', 'objects', 'agent'), 'ignored\n')

    const context = { cwd: root, projectId: 'project-test', generation: 7 }
    const listing = await listDir(root, '', false, context)
    const firstFile = listing.entries.findIndex((entry) => !entry.dir)
    ok(listing.status === 'ok', '文件树根层返回 ok 状态')
    ok(listing.request?.cwd === root && listing.request?.generation === 7, '文件树回显 cwd 与 generation')
    ok(firstFile >= 0 && listing.entries.slice(0, firstFile).every((entry) => entry.dir), '文件树目录排在文件前')
    ok(listing.skipped.includes('node_modules') && listing.skipped.includes('.git'), '文件树明确报告被隐藏的大型目录')

    const emptyDir = join(root, 'empty')
    await mkdir(emptyDir)
    const empty = await listDir(root, 'empty', false, context)
    ok(empty.status === 'empty' && empty.entries.length === 0, '文件树区分空目录')

    const missing = await listDir(root, 'does-not-exist', false, context)
    ok(missing.status === 'missing', '文件树区分不存在目录')
    const invalid = await listDir(root, '../', false, context)
    ok(invalid.status === 'invalid', '文件树拒绝越界路径')

    const manyDir = join(root, 'many')
    await mkdir(manyDir)
    await Promise.all(Array.from({ length: 405 }, (_, i) => writeFile(join(manyDir, `file-${String(i).padStart(3, '0')}.txt`), 'x')))
    const many = await listDir(root, 'many', false, context)
    ok(many.truncated && many.entries.length === 400 && many.totalEntries === 405, '文件树对过大目录有界截断并报告总数')

    const searchRequest = { ...context, requestId: 'search-1', query: 'agent', limit: 20 }
    const found = await searchFiles(searchRequest)
    ok(found.status === 'ok' && found.entries.some((entry) => entry.path === 'src/main/agent.ts'), '项目搜索能找到嵌套文件')
    ok(!found.entries.some((entry) => entry.path.includes('node_modules') || entry.path.includes('.git')), '项目搜索跳过依赖与 git 目录')
    ok(found.request.requestId === 'search-1' && found.request.cwd === root, '项目搜索回显请求身份')

    const limited = await searchFiles({ ...context, requestId: 'search-2', query: 'e', limit: 1 })
    ok(limited.entries.length === 1 && limited.truncated, '项目搜索对结果数量设上限并报告截断')
    const noMatch = await searchFiles({ ...context, requestId: 'search-3', query: 'definitely-no-such-file', limit: 20 })
    ok(noMatch.status === 'empty' && noMatch.entries.length === 0, '项目搜索区分无匹配')

    const controller = new AbortController()
    controller.abort()
    const cancelled = await searchFiles({ ...context, requestId: 'search-4', query: 'agent', limit: 20 }, controller.signal)
    ok(cancelled.status === 'cancelled', '项目搜索响应 AbortSignal 取消')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
