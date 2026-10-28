import fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { applyTestEnv, isIsolatedTestEnv } from './lib/test-env.mjs'

const FILE_COUNT = 60
const LINE_CHARS = 2000
const LINE_COUNT = 220
const ENTRY_BYTES = 100 * 1024 + 3 + 300 * 1024
const MAX_INDEX_BYTES = 16 * 1024 * 1024

function sessionFile(id, marker) {
  const filler = 'abcdefghij'.repeat(LINE_CHARS / 10)
  const lines = [
    JSON.stringify({ type: 'session', id }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: `${marker} ${id}` } })
  ]
  for (let i = 0; i < LINE_COUNT; i++) {
    const role = i % 2 ? 'assistant' : 'user'
    lines.push(JSON.stringify({ type: 'message', message: { role, content: filler } }))
  }
  return `${lines.join('\n')}\n`
}

function installOpenCounter() {
  const opened = []
  const handles = new Map()
  const originalOpen = fs.open
  const originalRead = fs.read
  const originalPromiseOpen = fs.promises.open
  let sink = null
  fs.open = (...args) => {
    const callback = args[args.length - 1]
    if (!sink || typeof callback !== 'function') return originalOpen(...args)
    const path = String(args[0])
    args[args.length - 1] = (error, fd) => {
      if (!error) {
        const item = { path, bytes: 0 }
        opened.push(item)
        handles.set(fd, item)
      }
      callback(error, fd)
    }
    return originalOpen(...args)
  }
  fs.read = (...args) => {
    const item = sink && typeof args[0] === 'number' ? handles.get(args[0]) : undefined
    const callback = args[args.length - 1]
    if (!item || typeof callback !== 'function') return originalRead(...args)
    args[args.length - 1] = (error, bytesRead, buffer) => {
      if (!error) item.bytes += bytesRead
      callback(error, bytesRead, buffer)
    }
    return originalRead(...args)
  }
  fs.promises.open = (...args) => {
    if (sink) opened.push({ path: String(args[0]), bytes: 0 })
    return originalPromiseOpen(...args)
  }
  return {
    async round(mod, query) {
      opened.length = 0
      handles.clear()
      sink = opened
      try {
        const result = await mod.searchSessionText(query, 100)
        return { result, opened: opened.map((item) => ({ ...item })), bytes: opened.reduce((sum, item) => sum + item.bytes, 0) }
      } finally {
        sink = null
      }
    },
    restore() {
      fs.open = originalOpen
      fs.read = originalRead
      fs.promises.open = originalPromiseOpen
    }
  }
}

export async function runSessionSearchCacheTests(ok) {
  const isolated = isIsolatedTestEnv()
  const root = isolated ? null : applyTestEnv()
  const sessionsDir = process.env.YAN_SESSIONS_DIR
  const outfile = resolve('.tmp/perf-fix/search-cache/out/session-search.mjs')
  mkdirSync(join(outfile, '..'), { recursive: true })
  const counter = installOpenCounter()
  try {
    const files = []
    for (let i = 0; i < FILE_COUNT; i++) {
      const name = `session-${String(i).padStart(2, '0')}.jsonl`
      const path = join(sessionsDir, name)
      writeFileSync(path, sessionFile(String(i).padStart(2, '0'), 'inkstone-hit'))
      files.push(path)
    }
    const totalBytes = files.reduce((sum, path) => sum + statSync(path).size, 0)

    await build({ entryPoints: ['src/main/session-search.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
    const mod = await import(`${pathToFileURL(outfile).href}?round=${Date.now()}`)

    const first = await counter.round(mod, 'inkstone-hit')
    ok(first.opened.length === FILE_COUNT, `首轮打开全部会话文件（打开 ${first.opened.length}/${FILE_COUNT}）`)
    ok(first.bytes === totalBytes, `首轮读到全部字节（${first.bytes}/${totalBytes}）`)
    ok(first.result.total === FILE_COUNT, '首轮文件总数正确')
    ok(first.result.hits.length === FILE_COUNT, '首轮所有命中文件都返回')
    ok(first.result.indexed * ENTRY_BYTES <= MAX_INDEX_BYTES, `首轮索引字节不超过上限（${first.result.indexed} × ${ENTRY_BYTES}）`)
    ok((first.result.indexed + 1) * ENTRY_BYTES > MAX_INDEX_BYTES, '首轮索引装满到上限附近，淘汰确实发生')

    const second = await counter.round(mod, 'inkstone-hit')
    const secondNames = new Set(second.opened.map((item) => item.path))
    const missBudget = FILE_COUNT - first.result.indexed + 1
    ok(second.opened.length === FILE_COUNT - first.result.indexed, `次轮只重读首轮未入索引的会话（${second.opened.length} 个）`)
    ok(second.bytes < first.bytes, `次轮读取字节少于首轮（${second.bytes} < ${first.bytes}）`)
    ok(secondNames.size === second.opened.length, '次轮没有重复打开同一文件')
    ok(second.result.indexed === first.result.indexed, '本轮未访问项没有被提前淘汰（索引条数不变）')
    ok(second.result.hits.length === FILE_COUNT, '次轮命中数不变')
    console.log(`搜索缓存：首轮打开 ${first.opened.length} 个文件/读取 ${first.bytes} 字节；次轮打开 ${second.opened.length} 个/读取 ${second.bytes} 字节（索引 ${second.result.indexed} 条）`)

    const cached = files.filter((path) => !secondNames.has(path))
    ok(cached.length > 0, '次轮留有已缓存的会话可继续观察')
    const changed = cached[0]
    const before = statSync(changed)
    writeFileSync(changed, sessionFile('changed', 'inkstone-changed'))
    utimesSync(changed, new Date(before.atimeMs + 5000), new Date(before.mtimeMs + 5000))
    const third = await counter.round(mod, 'inkstone-changed')
    ok(third.opened.some((item) => item.path === changed), '文件变化后必重读')
    ok(third.result.hits.length === 1 && third.result.hits[0].path === changed, '重读后按新内容命中')
    ok(third.opened.length <= missBudget, `变化只影响该文件（打开 ${third.opened.length} ≤ ${missBudget}）`)
    ok(third.result.indexed === first.result.indexed, '替换缓存不额外淘汰（索引条数不变）')

    const thirdNames = new Set(third.opened.map((item) => item.path))
    const doomed = files.find((path) => !thirdNames.has(path) && !secondNames.has(path))
    ok(!!doomed, '存在仍在索引中的会话用于删除验证')
    unlinkSync(doomed)
    const fourth = await counter.round(mod, 'inkstone-hit')
    ok(fourth.result.total === FILE_COUNT - 1, '已删除文件不再计入总数')
    ok(!fourth.result.hits.some((hit) => hit.path === doomed), '已删除文件不再出现在命中里')
    ok(fourth.result.indexed === first.result.indexed, '已删除文件从索引移除，腾出的额度被未入索引的会话复用')
    ok(fourth.result.indexed * ENTRY_BYTES <= MAX_INDEX_BYTES, '删除后索引字节仍不超过上限')
    ok(fourth.opened.length <= missBudget, `删除后仍只读未入索引的会话（打开 ${fourth.opened.length} ≤ ${missBudget}）`)

    const [stale, latest, otherWindow, anonymous] = await Promise.all([
      mod.searchSessionText('inkstone-hit', 100, 'sender:1'),
      mod.searchSessionText('inkstone-hit', 100, 'sender:1'),
      mod.searchSessionText('inkstone-hit', 100, 'sender:2'),
      mod.searchSessionText('inkstone-hit', 100)
    ])
    const expected = fourth.result.hits.length
    ok(stale.hits.length === 0, `同一窗口被新查询取代的旧查询不再扫描（命中 ${stale.hits.length}）`)
    ok(latest.hits.length === expected, `同一窗口的最新查询完整返回（${latest.hits.length}/${expected}）`)
    ok(otherWindow.hits.length === expected, `其他窗口的查询不被取消（${otherWindow.hits.length}/${expected}）`)
    ok(anonymous.hits.length === expected, `不带发起方的查询不参与取消（${anonymous.hits.length}/${expected}）`)
    const after = await mod.searchSessionText('inkstone-hit', 100, 'sender:1')
    ok(after.hits.length === expected && after.indexed === fourth.result.indexed, '取消后共享索引完好，后续查询结果不变')
  } finally {
    counter.restore()
    if (root) rmSync(root, { recursive: true, force: true })
  }
}

export default runSessionSearchCacheTests

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let failed = 0
  let passed = 0
  const ok = (cond, name) => {
    if (cond) passed++
    else {
      failed++
      console.error(`✗ ${name}`)
    }
  }
  await runSessionSearchCacheTests(ok)
  console.log(failed ? `✗ ${failed} 失败，${passed} 通过` : `✓ 会话搜索缓存：${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
