import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const DAY = 24 * 60 * 60 * 1000

await runSuite(import.meta.url, async (ok, compile) => {
  const { pruneSubagentOutputs, subagentOutputsTotal, stampSavedOutputs, SAVED_AT_MARKER } = await compile(undefined, { stdin: { contents: "export * from './src/main/subagent-prune.ts'\nexport { stampSavedOutputs, SAVED_AT_MARKER } from './src/main/subagent-outputs-stamp.ts'", resolveDir: process.cwd(), loader: 'ts' } })
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-outputs-prune-'))
  const now = Date.now()
  const ago = (days) => new Date(now - days * DAY)
  const make = async (id, savedDaysAgo, bytes, fileDaysAgo = 400) => {
    const outputs = join(dir, `${id}-outputs`)
    await mkdir(join(outputs, '.tmp'), { recursive: true })
    const file = join(outputs, '.tmp', 'out.bin')
    await writeFile(file, Buffer.alloc(bytes))
    await utimes(file, ago(fileDaysAgo), ago(fileDaysAgo))
    await stampSavedOutputs(outputs, ago(savedDaysAgo))
    await writeFile(join(dir, `${id}.json`), '{}')
    await writeFile(join(dir, `${id}.patch`), 'diff')
  }
  try {
    await make('sub-0000000a', 40, 100)
    await make('sub-0000000b', 40, 100)
    await make('sub-0000000c', 10, 300)
    await make('sub-0000000d', 5, 300)
    await make('sub-0000000e', 3, 300)
    await make('sub-0000000f', 0, 900)
    ok(Math.abs((await stat(join(dir, 'sub-0000000c-outputs'))).mtimeMs - ago(10).getTime()) < 2000, '目录本身记下另存时间（目录 mtime）')
    ok((await subagentOutputsTotal(dir)) === 2000, '合计占用按另存目录逐个统计')

    const first = await pruneSubagentOutputs(dir, { now, keepDays: 30, maxBytes: 10_000, keepIds: new Set(['sub-0000000b']) })
    ok(first.removed.join() === 'sub-0000000a', '按另存时间计龄：超过保留期的删除，文件本身很旧但另存不到 30 天的不删；保留名单里的不删', JSON.stringify(first))
    ok(existsSync(join(dir, 'sub-0000000b-outputs')), '保留名单里的过期目录不删')
    ok(existsSync(join(dir, 'sub-0000000a.json')) && existsSync(join(dir, 'sub-0000000a.patch')), '只删另存目录，记录和补丁不动')

    const capped = await pruneSubagentOutputs(dir, { now, keepDays: 30, maxBytes: 1200, protect: (id) => id === 'sub-0000000b' })
    ok(capped.removed.join() === 'sub-0000000c,sub-0000000d' && capped.bytes === 1200 && capped.inUse === 100, '超出总量上限时按另存时间最旧先删，删到不超为止；总量只计未受保护的目录', JSON.stringify(capped))
    ok(existsSync(join(dir, 'sub-0000000f-outputs')), '一天内刚另存的目录即使超限也不删')

    const tight = await pruneSubagentOutputs(dir, { now, keepDays: 30, maxBytes: 100 })
    ok(tight.removed.join() === 'sub-0000000b,sub-0000000e' && existsSync(join(dir, 'sub-0000000f-outputs')), '不再受保护的过期目录照常删除，最新一份始终保留', JSON.stringify(tight))
    ok(warnings.some((line) => line.includes('still exceed')), '删完仍超上限时停止并记日志')

    const src = join(dir, 'worktree', '.tmp')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'old.bin'), Buffer.alloc(500))
    await utimes(join(src, 'old.bin'), ago(60), ago(60))
    const moved = join(dir, 'sub-00000010-outputs')
    await mkdir(moved, { recursive: true })
    await rename(src, join(moved, '.tmp'))
    await stampSavedOutputs(moved)
    ok((await stat(join(moved, '.tmp', 'old.bin'))).mtimeMs < now - 59 * DAY, '搬入的文件保留原来的旧 mtime')
    const sameDay = await pruneSubagentOutputs(dir, { now, keepDays: 30, maxBytes: 100 })
    ok(!sameDay.removed.includes('sub-00000010') && existsSync(join(moved, '.tmp', 'old.bin')), '搬入旧 mtime 文件后：当天即使超限也不删', JSON.stringify(sameDay))
    const within = await pruneSubagentOutputs(dir, { now: now + 20 * DAY, keepDays: 30, maxBytes: 10_000 })
    ok(!within.removed.includes('sub-00000010') && existsSync(join(moved, '.tmp', 'old.bin')), '搬入旧 mtime 文件后：30 天内不删', JSON.stringify(within))
    const guarded = await pruneSubagentOutputs(dir, { now: now + 31 * DAY, keepDays: 30, maxBytes: 10_000, protect: (id) => id === 'sub-00000010' })
    ok(!guarded.removed.includes('sub-00000010'), '仍在使用（protect）时过期也不删')
    const after = await pruneSubagentOutputs(dir, { now: now + 31 * DAY, keepDays: 30, maxBytes: 10_000 })
    ok(after.removed.includes('sub-00000010') && !existsSync(moved), '从最近一次另存起超过 30 天才删', JSON.stringify(after))

    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep.txt'), 'keep')
    const link = join(dir, 'sub-00000011-outputs')
    symlinkSync(outside, link, 'junction')
    const linked = await pruneSubagentOutputs(dir, { now: now + 400 * DAY, keepDays: 30, maxBytes: 0 })
    ok(!linked.removed.includes('sub-00000011') && existsSync(join(outside, 'keep.txt')), '名为 -outputs 的联接不当另存目录处理，不删也不跟进去', JSON.stringify(linked))

    const big = await mkdtemp(join(tmpdir(), 'inkstone-outputs-inuse-'))
    const makeIn = async (root, id, savedDaysAgo, bytes) => {
      const outputs = join(root, `${id}-outputs`)
      await mkdir(outputs, { recursive: true })
      await writeFile(join(outputs, 'out.bin'), Buffer.alloc(bytes))
      await stampSavedOutputs(outputs, ago(savedDaysAgo))
    }
    await makeIn(big, 'sub-000000a1', 50, 5000)
    await makeIn(big, 'sub-000000a2', 10, 300)
    await makeIn(big, 'sub-000000a3', 5, 300)
    await makeIn(big, 'sub-000000a4', 2, 300)
    warnings.length = 0
    const inUse = await pruneSubagentOutputs(big, { now, keepDays: 30, maxBytes: 1000, protect: (id) => id === 'sub-000000a1' })
    ok(inUse.removed.length === 0 && inUse.inUse === 5000 && existsSync(join(big, 'sub-000000a2-outputs')) && existsSync(join(big, 'sub-000000a4-outputs')), '受保护目录占满上限时，不因此删掉其他 30 天内的目录', JSON.stringify(inUse))
    ok(warnings.some((line) => line.includes('still exceed') && line.includes('5000')), '只剩受保护目录仍超上限：停止并记日志', warnings.join(' | '))
    await rm(big, { recursive: true, force: true })

    const fallback = await mkdtemp(join(tmpdir(), 'inkstone-outputs-stamp-'))
    const failUtimes = { utimes: async () => { throw new Error('EPERM') }, writeFile: (path, data) => writeFile(path, data) }
    const failBoth = { utimes: async () => { throw new Error('EPERM') }, writeFile: async () => { throw new Error('EPERM') } }
    const marked = join(fallback, 'sub-000000b1-outputs')
    await mkdir(join(marked, '.tmp'), { recursive: true })
    ok((await stampSavedOutputs(marked, ago(0), failUtimes)) === 'marker' && Number(readFileSync(join(marked, SAVED_AT_MARKER), 'utf8')) === ago(0).getTime(), 'utimes 失败：改写固定名的时间标记文件')
    await writeFile(join(marked, '.tmp', 'new.bin'), Buffer.alloc(10))
    await utimes(marked, ago(60), ago(60))
    const markedIn20 = await pruneSubagentOutputs(fallback, { now: now + 20 * DAY, keepDays: 30, maxBytes: 10_000 })
    ok(!markedIn20.removed.includes('sub-000000b1'), '目录自身时间停在 60 天前时，计龄优先读标记文件：30 天内不删', JSON.stringify(markedIn20))
    ok((await stampSavedOutputs(marked, new Date(now + 25 * DAY))) === 'utimes' && Number(readFileSync(join(marked, SAVED_AT_MARKER), 'utf8')) === now + 25 * DAY, '之后 utimes 成功时同步更新已有标记，旧标记不会让目录显得更老')
    const markedLater = await pruneSubagentOutputs(fallback, { now: now + 50 * DAY, keepDays: 30, maxBytes: 10_000 })
    ok(!markedLater.removed.includes('sub-000000b1'), '按最近一次另存计龄', JSON.stringify(markedLater))
    const markedGone = await pruneSubagentOutputs(fallback, { now: now + 56 * DAY, keepDays: 30, maxBytes: 10_000 })
    ok(markedGone.removed.includes('sub-000000b1'), '标记时间超过 30 天才删', JSON.stringify(markedGone))

    const blind = join(fallback, 'sub-000000b2-outputs')
    await mkdir(blind, { recursive: true })
    await writeFile(join(blind, 'old.bin'), Buffer.alloc(10))
    await utimes(blind, ago(40), ago(40))
    warnings.length = 0
    ok((await stampSavedOutputs(blind, ago(0), failBoth)) === 'memory' && !existsSync(join(blind, SAVED_AT_MARKER)), 'utimes 与标记文件都失败：记为刚保存')
    ok(warnings.some((line) => line.includes('just saved')), '两者都失败时记日志', warnings.join(' | '))
    const blindNow = await pruneSubagentOutputs(fallback, { now, keepDays: 30, maxBytes: 0 })
    ok(!blindNow.removed.includes('sub-000000b2') && existsSync(blind), '本轮清理跳过它：即使目录时间是 40 天前、超出上限也不删', JSON.stringify(blindNow))
    await rm(fallback, { recursive: true, force: true })
  } finally {
    console.warn = warn
    await rm(dir, { recursive: true, force: true })
  }
}, { isolate: true })
