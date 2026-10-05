/**
 * 会话正文检索（主进程侧）：真文件、临时目录。验证遍历、缓存失效与排序。
 * 用法： node scripts/test-session-search-files.mjs
 */
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const sessions = await mkdtemp(join(tmpdir(), 'yan-ss-'))
const data = await mkdtemp(join(tmpdir(), 'yan-ss-data-'))
process.env.YAN_SESSIONS_DIR = sessions
process.env.YAN_DATA_DIR = data

let failed = 0
const ok = (cond, name, extra = '') => {
  if (!cond) failed += 1
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}
const line = (role, text) => JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } })
const file = (name, lines) => writeFile(name, [JSON.stringify({ type: 'session', id: 'x' }), ...lines].join('\n'))

await build({ entryPoints: ['src/main/session-search.ts'], outfile: 'out/test/session-search.mjs', bundle: true, format: 'esm', platform: 'node', external: ['electron'], logLevel: 'silent' })
const mod = await import(pathToFileURL(resolve('out/test/session-search.mjs')).href)

try {
  const dirA = join(sessions, '--C--proj-a--')
  const dirB = join(sessions, '--C--proj-b--')
  await mkdir(dirA)
  await mkdir(dirB)
  const a = join(dirA, 'a.jsonl')
  const b = join(dirB, 'b.jsonl')
  const flat = join(sessions, 'flat.jsonl')
  await file(a, [line('user', '分析 APK 的签名校验'), line('assistant', '用 jadx 反编译，校验在 native 层')])
  await file(b, [line('user', '修复僵尸转化的空指针崩溃'), line('assistant', '空指针来自未初始化的单位列表')])
  await file(flat, [line('user', '一个平铺目录里的会话：APK 打包')])
  await writeFile(join(dirA, 'notes.txt'), 'APK 这不是会话文件')
  const past = Date.now() / 1000 - 5 * 24 * 3600
  await utimes(a, past, past)

  const r1 = await mod.searchSessionText('apk 签名')
  ok(r1.hits.length === 1 && r1.hits[0].path === a, '所有词都要出现：只命中 a', `hits=${r1.hits.length}`)
  ok(r1.hits[0]?.snippet.includes('APK'), '命中带片段')
  const r2 = await mod.searchSessionText('空指针')
  ok(r2.hits.length === 1 && r2.hits[0].path === b, '子目录里的会话也能搜到')
  const r3 = await mod.searchSessionText('apk')
  ok(r3.hits.length === 2 && r3.hits.some((h) => h.path === flat), '平铺目录的会话也能搜到，.txt 不算', `hits=${r3.hits.length}`)
  ok(r3.hits[0].path === flat, '同样命中时新的排前面')
  ok((await mod.searchSessionText('jadx 不存在')).hits.length === 0, '少一个词就不命中')
  ok((await mod.searchSessionText('   ')).hits.length === 0, '空查询没有结果')
  ok((await mod.searchSessionText('secret')).hits.length === 0, '没有出现过的词没有结果')

  await file(b, [line('user', '改成搜索新的内容 zebra')])
  const later = Date.now() / 1000 + 10
  await utimes(b, later, later)
  ok((await mod.searchSessionText('zebra')).hits.length === 1, '文件变了索引会更新')
  ok((await mod.searchSessionText('空指针')).hits.length === 0, '旧内容不再命中')

  await rm(b)
  ok((await mod.searchSessionText('zebra')).hits.length === 0, '文件被删了结果里就没有了')
} finally {
  await rm(sessions, { recursive: true, force: true }).catch(() => undefined)
  await rm(data, { recursive: true, force: true }).catch(() => undefined)
}
console.log(failed ? `${failed} 项失败` : '会话检索（文件）：全部通过')
process.exit(failed ? 1 : 0)
