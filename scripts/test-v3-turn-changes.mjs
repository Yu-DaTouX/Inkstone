#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, label + (detail === undefined ? '' : `  ← 实际: ${JSON.stringify(detail)}`))
  checks++
  console.log(`✓ ${label}`)
}

const dir = await mkdtemp(join(tmpdir(), 'v3-turn-changes-'))
try {
  const out = join(dir, 'turn-changes.mjs')
  await build({
    entryPoints: [join(ROOT, 'src/renderer/src/features/session/turn-changes.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const { collectTurnChanges, splitChangePath, isInsideCwd, groupChangesByDir } = await import(pathToFileURL(out).href)

  const diff = (path, added, removed, status = 'modified') => ({
    fileDiff: { path, added, removed, status, patch: '', before: { text: '' }, after: { text: '' } }
  })
  const call = (id, details, status = 'success') => ({ id, name: 'edit', status, args: {}, details })

  ok(collectTurnChanges([]) === null, '没有工具调用时不出卡')
  ok(collectTurnChanges([call('a', {})]) === null, '没有前后快照的调用不计入')
  ok(collectTurnChanges([call('a', diff('x.ts', 3, 1, 'unchanged'))]) === null, '内容没变的不计入')
  ok(collectTurnChanges([call('a', diff('x.ts', 3, 1), 'running')]) === null, '还在跑的不计入')

  const merged = collectTurnChanges([call('a', diff('src/a.ts', 3, 1)), call('b', diff('src/b.ts', 5, 0, 'created')), call('c', diff('src/a.ts', 2, 2))])
  ok(merged?.files.length === 2, '同一路径多次编辑合并为一行', merged?.files)
  ok(merged?.files[0].added === 5 && merged?.files[0].removed === 3, '同一路径行数累加', merged?.files[0])
  ok(merged?.added === 10 && merged?.removed === 3, '合计行数', merged)

  const unknown = collectTurnChanges([call('a', diff('a.ts', -1, -1)), call('b', diff('b.ts', 2, 1))])
  ok(unknown?.files.length === 2 && unknown.added === -1 && unknown.removed === -1, '任一处拿不到行数时合计记 -1（界面省略数字）', unknown)

  ok(isInsideCwd('E:\\proj\\src\\a.ts', 'e:/proj') && isInsideCwd('src/a.ts', 'E:\\proj') && isInsideCwd('./a.ts', '/proj/'), 'cwd 之内（绝对、相对、大小写与斜杠方向不同）算项目文件')
  ok(!isInsideCwd('C:\\Users\\me\\AppData\\Local\\Temp\\yan-news\\na.json', 'E:\\proj') && !isInsideCwd('/tmp/yan-news/na.json', '/proj'), '系统临时目录等 cwd 之外的路径不算')
  ok(!isInsideCwd('E:\\proj-other\\a.ts', 'E:\\proj') && !isInsideCwd('../x.ts', '/proj/sub') && !isInsideCwd('src/../../x.ts', '/proj'), '同前缀兄弟目录与 .. 逃逸不算')
  ok(isInsideCwd('/anywhere/a.ts', undefined) && isInsideCwd('/anywhere/a.ts', ''), '拿不到 cwd 时不过滤')
  ok(isInsideCwd('E:\\Proj\\Src\\a.ts', 'e:\\proj\\src'), 'Windows 盘符路径折叠大小写')
  ok(isInsideCwd('/proj/src/a.ts', '/proj/src'), 'POSIX 路径同大小写算 cwd 内')
  ok(!isInsideCwd('/proj/Src/a.ts', '/proj/src'), 'POSIX 路径大小写敏感，不同大小写不算同一目录')

  const scoped = collectTurnChanges([call('a', diff('E:\\proj\\src\\a.ts', 1, 0)), call('b', diff('C:\\Temp\\yan-news\\na.json', 1, 2)), call('c', diff('rel/b.ts', 2, 0, 'created'))], 'E:\\proj')
  ok(scoped?.files.length === 2 && scoped.files.every((f) => !f.path.includes('yan-news')), '统计只含工作目录内的文件', scoped?.files)
  ok(scoped?.added === 3 && scoped?.removed === 0, '增删合计不含目录外文件', scoped)
  ok(collectTurnChanges([call('a', diff('C:\\Temp\\yan-news\\na.json', 1, 2)), call('b', diff('/tmp/eu.json', 1, 2))], 'E:\\proj') === null, '过滤后一个不剩则不出卡')
  ok(collectTurnChanges([call('a', diff('/tmp/eu.json', 1, 2))])?.files.length === 1, '未传 cwd 时保持原行为')

  const rel = splitChangePath('E:\\proj\\docs\\DESIGN_SYSTEM.md', 'e:/proj')
  ok(rel.dir === 'docs/' && rel.base === 'DESIGN_SYSTEM.md', '在 cwd 下的路径显示为相对路径（忽略大小写与斜杠方向）', rel)
  const outside = splitChangePath('/tmp/a/b.txt', '/proj')
  ok(outside.dir === '…/a/' && outside.base === 'b.txt', 'cwd 之外的绝对路径只保留最后一级目录', outside)
  const shallow = splitChangePath('/tmp/b.txt', '/proj')
  ok(shallow.dir === '/tmp/' && shallow.base === 'b.txt', 'cwd 之外只有一级目录时原样显示', shallow)
  ok(splitChangePath('a.ts').dir === '' && splitChangePath('a.ts').base === 'a.ts', '没有目录的文件名', splitChangePath('a.ts'))

  const grouped = groupChangesByDir([
    { path: 'E:\\proj\\src\\a.ts', status: 'modified', added: 3, removed: 1 },
    { path: 'E:\\proj\\src\\b.ts', status: 'created', added: 5, removed: 0 },
    { path: 'E:\\proj\\README.md', status: 'modified', added: 1, removed: 1 },
    { path: 'E:\\proj\\scripts\\x.mjs', status: 'modified', added: -1, removed: -1 }
  ], 'E:\\proj')
  ok(grouped.length === 3 && grouped[0].dir === 'src/' && grouped[0].files.length === 2, '按所在目录分组，保持首次出现顺序', grouped.map((g) => [g.dir, g.files.length]))
  ok(grouped[0].added === 8 && grouped[0].removed === 1, '目录合计行数', grouped[0])
  ok(grouped[1].dir === '' && grouped[1].files[0].base === 'README.md', '根目录文件不建目录组', grouped[1])
  ok(grouped[2].added === 0 && grouped[2].removed === 0, '拿不到行数的文件不计入目录合计', grouped[2])

  console.log(`\nv3-turn-changes: ${checks} checks passed`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
