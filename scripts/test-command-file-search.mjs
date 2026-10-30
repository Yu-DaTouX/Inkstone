import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(relative) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const items = await load('../src/renderer/src/features/commands/command-items.ts')
const search = await load('../src/renderer/src/features/commands/command-file-search.ts')

assert.deepEqual(items.parsePaletteQuery('/app tsx'), { mode: 'file', term: 'app tsx' }, '/ 进入文件模式')
assert.deepEqual(items.parsePaletteQuery('％ needle'), { mode: 'content', term: 'needle' }, '全角 % 进入内容模式')
assert.deepEqual(items.parsePaletteQuery('／x'), { mode: 'file', term: 'x' }, '全角 / 进入文件模式')
assert.ok(items.COMMAND_PREFIXES.includes('/') && items.COMMAND_PREFIXES.includes('%'), '前缀进入 ? 帮助')
assert.ok(items.PALETTE_GROUP_ORDER.indexOf('file') < items.PALETTE_GROUP_ORDER.indexOf('help'), '帮助仍在最后')

const request = { cwd: 'C:\\p', generation: 0, requestId: 'r', query: 'x' }
const names = search.fileNameItems({
  request,
  matches: [
    { path: 'src\\app\\App.tsx', name: 'App.tsx', directory: false, positions: [], score: 9 },
    { path: 'src/app', name: 'app', directory: true, positions: [], score: 8 },
    { path: 'README.md', name: 'README.md', directory: false, positions: [], score: 1 }
  ],
  truncated: false,
  source: 'git',
  scanned: 3
})
assert.deepEqual(
  names.map((item) => [item.id, item.group, item.label, item.meta, item.filePath]),
  [
    ['file:src/app/App.tsx', 'file', 'App.tsx', 'src/app', 'src/app/App.tsx'],
    ['file:README.md', 'file', 'README.md', '', 'README.md']
  ],
  '文件结果去掉目录、统一斜杠、父目录作说明'
)
assert.equal(search.fileNameIssue({ request, matches: [], truncated: false, source: 'none', scanned: 0, error: { code: 'superseded' } }), null, '被取代不算失败')
assert.equal(search.fileNameIssue({ request, matches: [], truncated: false, source: 'none', scanned: 0, error: { code: 'timeout' } }), 'failed', '超时算失败')

const content = {
  request,
  hits: [
    { path: 'src/a.ts', name: 'a.ts', line: 12, column: 5, text: '    const   needle = 1', ranges: [[12, 18]] },
    { path: 'src/a.ts', name: 'a.ts', line: 12, text: 'dup', ranges: [] },
    { path: 'docs\\b.md', name: 'b.md', line: 3, text: `${'x'.repeat(80)} needle ${'y'.repeat(80)}`, ranges: [[81, 87]] }
  ],
  status: 'ok',
  truncated: false,
  scannedFiles: 2,
  skippedFiles: 0
}
const hits = search.contentHitItems(content)
assert.equal(hits.length, 2, '同文件同一行只保留一条')
assert.deepEqual(
  [hits[0].id, hits[0].label, hits[0].meta, hits[0].line, hits[0].column, hits[0].filePath],
  ['content:src/a.ts:12', 'const needle = 1', 'a.ts:12', 12, 5, 'src/a.ts'],
  '内容结果带行号与压缩空白的片段'
)
assert.ok(hits[1].label.startsWith('…') && hits[1].label.includes('needle'), '长行片段从命中附近截取')
assert.ok(hits[1].label.length <= search.CONTENT_SNIPPET_MAX, '片段长度有上限')
assert.equal(hits[1].filePath, 'docs/b.md', '统一为正斜杠')
assert.equal(search.contentHitItems(content, 1).length, 1, '数量上限')

assert.equal(search.contentIssue({ ...content, status: 'pattern' }), 'pattern', '无效搜索词')
assert.equal(search.contentIssue({ ...content, status: 'partial' }), null, '部分结果不算失败')
assert.equal(search.contentIssue({ ...content, status: 'permission' }), 'failed', '权限错误')
assert.equal(search.contentTruncated({ ...content, truncation: ['scan-limit'] }), true, '扫描上限算截断')
assert.equal(search.contentTruncated(content, 2), true, '命中数超过上限算截断')
assert.equal(search.contentTruncated(content), false, '完整结果')

console.log('command file search ok')
