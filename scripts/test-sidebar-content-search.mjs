#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const report = { pass: 0, fail: 0 }

function ok(cond, label, detail) {
  if (cond) report.pass += 1
  else report.fail += 1
  process.stdout.write(`${cond ? '  ✓' : '  ✗'} ${label}${cond ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
}

const outdir = await mkdtemp(join(tmpdir(), 'yan-content-search-'))
try {
  const outfile = join(outdir, 'content-search.mjs')
  await build({
    entryPoints: [join(ROOT, 'src/renderer/src/features/sidebar/content-search.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  })
  const m = await import(pathToFileURL(outfile).href)

  ok(!m.shouldSearchContent('a') && !m.shouldSearchContent('  a '), '少于 2 个字不查全文')
  ok(m.shouldSearchContent('中继') && m.shouldSearchContent('ab'), '满 2 个字才查全文')

  const sessions = [
    { id: 's1', path: 'C:\\data\\sessions\\a.jsonl', title: '原标题 A', archivedAt: null },
    { id: 's2', path: 'C:\\data\\sessions\\b.jsonl', title: '原标题 B', archivedAt: 1 }
  ]
  const hits = [
    { path: 'C:/data/sessions/a.jsonl', snippet: 'a', matches: 3, updatedAt: 3 },
    { path: 'C:\\data\\sessions\\b.jsonl', snippet: 'b', matches: 2, updatedAt: 2 },
    { path: 'C:\\data\\sessions\\old.jsonl', snippet: 'old', matches: 1, updatedAt: 1 },
    { path: 'C:\\data\\sessions\\old.jsonl', snippet: 'dup', matches: 1, updatedAt: 1 }
  ]
  const base = {
    hits,
    sessions,
    titleOf: (item) => (item.id === 's2' ? '改过的 B' : item.title),
    fallbackTitle: (at) => `fallback-${at}`
  }

  const all = m.buildContentMatches({ ...base, shownPaths: [] })
  ok(all.length === 3, '同一路径只列一次', all.map((x) => x.path))
  ok(all[0].id === 's1' && all[0].path === sessions[0].path, '斜杠写法不同也能对上已加载会话，并用会话自身路径', all[0])
  ok(all[1].title === '改过的 B' && all[1].archived === true, '用手动标题并标出归档', all[1])
  ok(all[2].id === null && all[2].title === 'fallback-1', '左栏列表外的会话用日期标题', all[2])

  const deduped = m.buildContentMatches({ ...base, shownPaths: ['c:\\DATA\\sessions\\a.jsonl'] })
  ok(deduped.length === 2 && !deduped.some((x) => x.id === 's1'), '已按标题命中的会话不重复列出', deduped.map((x) => x.id))

  const limited = m.buildContentMatches({ ...base, shownPaths: [], limit: 1 })
  ok(limited.length === 1, '遵守条数上限', limited.length)

  const parts = m.splitSnippet('Relay 中继 relay 地址', 'relay 地址')
  ok(
    JSON.stringify(parts) ===
      JSON.stringify([
        { text: 'Relay', hit: true },
        { text: ' 中继 ', hit: false },
        { text: 'relay', hit: true },
        { text: ' ', hit: false },
        { text: '地址', hit: true }
      ]),
    '片段按关键字切分高亮（不分大小写、多个词）',
    parts
  )
  ok(m.splitSnippet('abc', '').length === 1 && !m.splitSnippet('abc', '')[0].hit, '空查询不高亮')
  ok(m.splitSnippet('', 'x').length === 0, '空片段返回空')
  ok(m.splitSnippet('a.b', '.').filter((p) => p.hit).map((p) => p.text).join() === '.', '正则特殊字符按字面匹配')

  const long = `${'前文'.repeat(20)}命中词后文`
  const focused = m.focusSnippet(long, '命中词')
  ok(focused.startsWith('…') && focused.indexOf('命中词') === 13, '关键字靠后时裁掉前文，保留少量前导', focused)
  ok(m.focusSnippet('短 命中', '命中') === '短 命中', '关键字靠前时不裁')
  ok(m.focusSnippet('没有', '命中') === '没有', '没有命中时原样返回')
} finally {
  await rm(outdir, { recursive: true, force: true })
}

process.stdout.write(`\n${report.pass} 通过，${report.fail} 失败\n`)
if (report.fail) process.exit(1)
