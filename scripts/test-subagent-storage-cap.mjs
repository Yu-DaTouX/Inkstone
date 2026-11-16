import './lib/test-isolate.mjs'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const DAY = 24 * 60 * 60 * 1000

await runSuite(import.meta.url, async (ok, compile) => {
  const prune = await compile('src/main/subagent-prune.ts')
  const now = Date.now()

  const settled = (record, ageDays) => prune.settledForPrune(record, { now, endedAt: now - ageDays * DAY })
  ok(!settled({ status: 'error', review: 'none' }, 29).reviewed, '已处理：未隐藏、未忽略的失败结束不满 30 天仍算未处理')
  ok(settled({ status: 'error', review: 'none' }, 31).reviewed, '已处理：未处理的失败结束满 30 天算已处理')
  ok(!settled({ status: 'error', review: 'pending' }, 90).reviewed, '已处理：待审的失败记录多久都不算已处理')
  ok(settled({ status: 'done', review: 'archived' }, 90).archived && !settled({ status: 'done', review: 'archived' }, 90).reviewed, '已处理：已存档补丁单独标出，不进普通保留期清理')
  ok(!prune.settledForPrune({ status: 'error', review: 'none' }).reviewed, '已处理：不给时间时沿用旧规则')

  const root = await mkdtemp(join(tmpdir(), 'inkstone-subagent-cap-'))
  const fixture = async (name) => {
    const dir = join(root, name)
    await mkdir(join(dir, 'sessions'), { recursive: true })
    const write = async (id, record, ageDays, sessionBytes = 1000, extra = {}) => {
      const at = now - ageDays * DAY
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ endedAt: at, ...record }))
      await utimes(join(dir, `${id}.json`), new Date(at), new Date(at))
      await mkdir(join(dir, 'sessions', id), { recursive: true })
      await writeFile(join(dir, 'sessions', id, 'a.jsonl'), Buffer.alloc(sessionBytes))
      if (extra.patch) await writeFile(join(dir, `${id}.patch`), Buffer.alloc(extra.patch))
      if (extra.outputs) {
        await mkdir(join(dir, `${id}-outputs`), { recursive: true })
        await writeFile(join(dir, `${id}-outputs`, 'out.bin'), Buffer.alloc(extra.outputs))
      }
    }
    return { dir, write }
  }

  try {
    const { dir, write } = await fixture('cap')
    await write('sub-0000000a', { status: 'done', review: 'none' }, 9, 1000, { outputs: 500 })
    await write('sub-0000000b', { status: 'running', review: 'none' }, 8)
    await write('sub-0000000c', { status: 'starting', review: 'none' }, 8)
    await write('sub-0000000d', { status: 'done', review: 'pending' }, 7, 1000, { patch: 50 })
    await write('sub-0000000e', { status: 'done', review: 'conflict' }, 7)
    await write('sub-0000000f', { status: 'error', review: 'none' }, 6)
    await write('sub-00000010', { status: 'done', review: 'merged' }, 5)
    await write('sub-00000011', { status: 'done', review: 'none' }, 5)
    await write('sub-00000012', { status: 'done', review: 'none' }, 4)
    await write('sub-00000013', { status: 'done', review: 'discarded' }, 3)
    await write('sub-00000014', { status: 'done', review: 'none' }, 2)
    await write('sub-00000015', { status: 'cancelled', review: 'none' }, 1)
    await writeFile(join(dir, 'sessions', 'sub-0000ffff.jsonl'), Buffer.alloc(10))

    const usage = await prune.subagentStorageUsage(dir)
    ok(usage.records === 12, '占用：按记录 JSON 计条数', JSON.stringify(usage))
    ok(usage.sessionBytes === 12 * 1000 + 10 && usage.patchBytes === 50 && usage.outputsBytes === 500, '占用：会话、补丁、另存产物分开统计', JSON.stringify(usage))
    ok(usage.maxBytes === 5120 * 1024 * 1024, '占用：默认总量上限 5GB', String(usage.maxBytes))
    ok(usage.untrackedBytes === 10, '占用：没有记录的会话文件单独统计', String(usage.untrackedBytes))

    const fresh = await prune.pruneSubagentArchive(dir, { now, keepDays: 30, keepCount: 1500, maxBytes: 10 ** 9, log: () => {} })
    ok(fresh.length === 0, '未超上限：都在保留期内，一条不删', JSON.stringify(fresh))

    const lines = []
    const removed = await prune.pruneSubagentArchive(dir, {
      now, keepDays: 30, keepCount: 1500, maxBytes: 10_000,
      liveIds: new Set(['sub-00000014']),
      protect: (id) => id === 'sub-00000013',
      recentKeepDays: 0,
      settledKeepCount: 0,
      log: (line) => lines.push(line)
    })
    ok(JSON.stringify(removed) === JSON.stringify(['sub-0000000a', 'sub-00000010', 'sub-00000011']), '超上限：按结束时间从旧到新删已结束且已处理的，低于上限即停', JSON.stringify(removed))
    ok(!existsSync(join(dir, 'sub-0000000a.json')) && !existsSync(join(dir, 'sessions', 'sub-0000000a')) && !existsSync(join(dir, 'sub-0000000a-outputs')), '超上限：记录、会话目录与该记录的另存产物一起删')
    ok(['0b', '0c', '0d', '0e', '0f', '12', '13', '14', '15'].every((n) => existsSync(join(dir, `sub-000000${n}.json`)) && existsSync(join(dir, 'sessions', `sub-000000${n}`))), '超上限：运行中、starting、待审、冲突、不满 30 天的失败、受保护、在用以及更新的都保留')
    ok(existsSync(join(dir, 'sub-0000000d.patch')), '超上限：待合并补丁保留')
    ok(lines.length === 2 && /over the .* limit/.test(lines[0]) && /removed 3 subagent records/.test(lines[1]) && /freed .* of sessions and records/.test(lines[1]), '日志：删除前后各一行，写明条数与释放量', lines.join(' | '))

    const stuckLines = []
    const stuck = await prune.pruneSubagentArchive(dir, { now, keepDays: 30, keepCount: 1500, maxBytes: 100, liveIds: new Set(['sub-0000000b', 'sub-0000000c']), protect: (id) => id === 'sub-0000000d' || id === 'sub-0000000e', recentKeepDays: 0, settledKeepCount: 0, log: (line) => stuckLines.push(line) })
    ok(stuck.length === 0 && ['12', '13', '14', '15'].every((n) => existsSync(join(dir, `sub-000000${n}.json`))), '全删可删记录也到不了上限：一条都不删', JSON.stringify(stuck))
    ok(stuckLines.length === 1 && /nothing was removed/.test(stuckLines[0]), '到不了上限时只记一行告警', stuckLines.join(' | '))
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const make = async (name) => {
    const dir = join(await mkdtemp(join(tmpdir(), `inkstone-subagent-${name}-`)))
    await mkdir(join(dir, 'sessions'), { recursive: true })
    const write = async (id, record, ageDays, sessionBytes = 1000) => {
      const at = now - ageDays * DAY
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ endedAt: at, ...record }))
      await utimes(join(dir, `${id}.json`), new Date(at), new Date(at))
      await mkdir(join(dir, 'sessions', id), { recursive: true })
      await writeFile(join(dir, 'sessions', id, 'a.jsonl'), Buffer.alloc(sessionBytes))
    }
    return { dir, write }
  }

  const orphan = await make('orphan')
  try {
    await mkdir(join(orphan.dir, 'sessions', 'sub-deadbeef'), { recursive: true })
    await writeFile(join(orphan.dir, 'sessions', 'sub-deadbeef', 'x.jsonl'), Buffer.alloc(50_000))
    await writeFile(join(orphan.dir, 'sub-cafe0000-idle-1.patch'), Buffer.alloc(5_000))
    await orphan.write('sub-000000b1', { status: 'done', review: 'none' }, 40)
    await orphan.write('sub-000000b2', { status: 'done', review: 'none' }, 39)
    await orphan.write('sub-000000b3', { status: 'done', review: 'none' }, 38)
    const removed = await prune.pruneSubagentArchive(orphan.dir, { now, keepDays: 30, keepCount: 1500, maxBytes: 2500, settledKeepCount: 0, log: () => {} })
    ok(JSON.stringify(removed) === JSON.stringify(['sub-000000b1']), '没有记录的会话目录与零散补丁不计入上限，只删到可删记录低于上限', JSON.stringify(removed))
    ok(existsSync(join(orphan.dir, 'sessions', 'sub-deadbeef')) && existsSync(join(orphan.dir, 'sub-cafe0000-idle-1.patch')), '没有记录的文件不动')
  } finally {
    await rm(orphan.dir, { recursive: true, force: true })
  }

  const blocked = await make('blocked')
  try {
    await blocked.write('sub-000000c1', { status: 'starting', review: 'none' }, 90, 20_000)
    await blocked.write('sub-000000c2', { status: 'done', review: 'pending' }, 90, 20_000)
    await blocked.write('sub-000000c3', { status: 'done', review: 'none' }, 60)
    await blocked.write('sub-000000c4', { status: 'done', review: 'merged' }, 1)
    const warned = []
    const removed = await prune.pruneSubagentArchive(blocked.dir, { now, keepDays: 30, keepCount: 1500, maxBytes: 10_000, settledKeepCount: 0, log: (line) => warned.push(line) })
    ok(removed.length === 0 && existsSync(join(blocked.dir, 'sub-000000c3.json')) && existsSync(join(blocked.dir, 'sub-000000c4.json')), '删不掉的记录（starting、待合并）超过上限时，不拿已处理记录填坑', JSON.stringify(removed))
    ok(warned.some((line) => /nothing was removed/.test(line)), '这种情况只记告警', warned.join(' | '))
  } finally {
    await rm(blocked.dir, { recursive: true, force: true })
  }

  const floors = await make('floors')
  try {
    for (const [n, age] of [['d1', 20], ['d2', 15], ['d3', 10], ['d4', 9], ['d5', 6], ['d6', 2]]) await floors.write(`sub-000000${n}`, { status: 'done', review: 'none' }, age)
    const removed = await prune.pruneSubagentArchive(floors.dir, { now, keepDays: 30, keepCount: 1500, maxBytes: 1, settledKeepCount: 2, log: () => {} })
    ok(removed.length === 0, '保留最近 7 天与最新若干条已处理记录后到不了上限：不删', JSON.stringify(removed))
    const fit = await prune.pruneSubagentArchive(floors.dir, { now, keepDays: 30, keepCount: 1500, maxBytes: 3500, settledKeepCount: 2, log: () => {} })
    ok(JSON.stringify(fit) === JSON.stringify(['sub-000000d1', 'sub-000000d2', 'sub-000000d3']), '按结束时间从最旧删，最近 7 天内结束的和最新 2 条不删', JSON.stringify(fit))
    ok(['d4', 'd5', 'd6'].every((n) => existsSync(join(floors.dir, `sub-000000${n}.json`))), '保留下来的记录还在')
  } finally {
    await rm(floors.dir, { recursive: true, force: true })
  }

  const guardedRoot = await make('guarded')
  try {
    await guardedRoot.write('sub-000000e1', { status: 'done', review: 'none' }, 90)
    await guardedRoot.write('sub-000000e2', { status: 'error', review: 'none' }, 90)
    const removed = await prune.pruneSubagentArchive(guardedRoot.dir, { now, keepDays: 30, keepCount: 0, maxBytes: 10 ** 9, protect: (id) => id === 'sub-000000e1', log: () => {} })
    ok(JSON.stringify(removed) === JSON.stringify(['sub-000000e2']), '保留期那一轮也跳过受保护的记录', JSON.stringify(removed))
  } finally {
    await rm(guardedRoot.dir, { recursive: true, force: true })
  }

  const cacheRoot = await make('cache')
  try {
    await cacheRoot.write('sub-000000f1', { status: 'done', review: 'none' }, 90)
    const first = await prune.cachedSubagentStorageUsage(cacheRoot.dir, now)
    await cacheRoot.write('sub-000000f2', { status: 'done', review: 'none' }, 90)
    const again = await prune.cachedSubagentStorageUsage(cacheRoot.dir, now + 60_000)
    ok(first.records === 1 && again.records === 1, '存储统计 5 分钟内复用缓存')
    const later = await prune.cachedSubagentStorageUsage(cacheRoot.dir, now + 6 * 60_000)
    ok(later.records === 2, '超过 5 分钟重新统计')
    await prune.pruneSubagentArchive(cacheRoot.dir, { now, keepDays: 30, keepCount: 0, maxBytes: 10 ** 9, log: () => {} })
    const after = await prune.cachedSubagentStorageUsage(cacheRoot.dir, now + 7 * 60_000)
    ok(after.records === 0, '清理删了记录后缓存失效', JSON.stringify(after))
  } finally {
    await rm(cacheRoot.dir, { recursive: true, force: true })
  }

  const archivedRoot = await mkdtemp(join(tmpdir(), 'inkstone-subagent-archived-'))
  try {
    const dir = archivedRoot
    await mkdir(join(dir, 'sessions'), { recursive: true })
    const write = async (id, ageDays) => {
      const at = now - ageDays * DAY
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ status: 'done', review: 'archived', endedAt: at }))
      await writeFile(join(dir, `${id}.patch`), Buffer.alloc(100))
      await utimes(join(dir, `${id}.json`), new Date(at), new Date(at))
      await mkdir(join(dir, 'sessions', id), { recursive: true })
      await writeFile(join(dir, 'sessions', id, 'a.jsonl'), Buffer.alloc(1000))
    }
    await write('sub-000000a1', 200)
    await write('sub-000000a2', 150)
    await write('sub-000000a3', 100)
    await write('sub-000000a4', 61)
    await write('sub-000000a5', 10)
    const within = await prune.pruneSubagentArchive(dir, { now, keepDays: 30, keepCount: 0, maxBytes: 10 ** 9, log: () => {} })
    ok(within.length === 0, '已存档补丁：没超上限时多旧都不删', JSON.stringify(within))
    const over = await prune.pruneSubagentArchive(dir, { now, keepDays: 30, keepCount: 0, maxBytes: 2500, archivedKeepCount: 2, settledKeepCount: 0, log: () => {} })
    ok(JSON.stringify(over) === JSON.stringify(['sub-000000a1', 'sub-000000a2', 'sub-000000a3']), '已存档补丁：超上限时从最旧删，不删最近 2 条与不满 60 天的', JSON.stringify(over))
    ok(!existsSync(join(dir, 'sub-000000a1.patch')) && existsSync(join(dir, 'sub-000000a4.patch')) && existsSync(join(dir, 'sub-000000a5.patch')), '已存档补丁：补丁随记录删除，保留的补丁还在')
  } finally {
    await rm(archivedRoot, { recursive: true, force: true })
  }
})
