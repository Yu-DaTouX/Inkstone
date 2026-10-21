import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-subagent-task-rows-'))
try {
  const outfile = join(dir, 'rows.mjs')
  await build({ entryPoints: ['src/shared/subagent-task-rows.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const rows = await import(pathToFileURL(outfile).href)

  const base = {
    id: 'sub-a1', task: '调查登录流程的并发问题\n细节', cwd: '/w', isolation: 'shared-cwd', status: 'running',
    startedAt: 1_000, transcript: [], review: 'none', toolCalls: 3, model: 'p/m', latestActivity: ' 读取 auth.ts '
  }
  const NOW = 31_000

  const running = rows.buildSubagentTaskRow(base, { now: NOW })
  assert.equal(running.state, 'running')
  assert.equal(running.canStop, true)
  assert.equal(running.description, '调查登录流程的并发问题')
  assert.equal(running.label, '正在调查登录流程的并发问题')
  assert.equal(running.latestActivity, '读取 auth.ts')
  assert.equal(running.durationMs, 30_000)
  assert.equal(running.summaryLine, null)
  assert.equal(running.model, 'p/m')

  const done = rows.buildSubagentTaskRow({ ...base, status: 'done', endedAt: 11_000, usage: { input: 1200, output: 800, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null, reportedMessages: 2 } }, { now: NOW })
  assert.equal(done.state, 'done')
  assert.equal(done.label, '已调查登录流程的并发问题')
  assert.equal(done.summaryLine, '3 个工具 · 2.0k tokens · 10s')
  assert.equal(done.canStop, false)
  assert.equal(done.latestActivity, null)
  assert.equal(done.durationMs, 10_000)

  const failed = rows.buildSubagentTaskRow({ ...base, status: 'error', endedAt: 5_000 }, { now: NOW })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.label, '调查失败：登录流程的并发问题')
  assert.equal(failed.tense, 'failed')

  const generic = rows.buildSubagentTaskRow({ ...base, task: '登录页打不开' }, { now: NOW })
  assert.equal(generic.label, '进行中：登录页打不开')
  assert.equal(rows.buildSubagentTaskRow({ ...base, task: '登录页打不开', status: 'done', endedAt: 2000 }, { now: NOW }).label, '已完成：登录页打不开')
  assert.equal(rows.buildSubagentTaskRow({ ...base, task: '登录页打不开', status: 'error', endedAt: 2000 }, { now: NOW }).label, '已失败：登录页打不开')

  const stopped = rows.buildSubagentTaskRow({ ...base, status: 'cancelled', endedAt: 2_000 }, { now: NOW })
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.label, '已停止：调查登录流程的并发问题')

  const en = rows.buildSubagentTaskRow({ ...base, task: 'Investigate flaky login test' }, { now: NOW, lang: 'en-US' })
  assert.equal(en.label, 'Investigating flaky login test')
  const enDone = rows.buildSubagentTaskRow({ ...base, task: 'Fix flaky login test', status: 'done', endedAt: 2_000, toolCalls: 1 }, { now: NOW, lang: 'en-US' })
  assert.equal(enDone.label, 'Fixed flaky login test')
  assert.equal(enDone.summaryLine, '1 tool · 1s')
  const enFail = rows.buildSubagentTaskRow({ ...base, task: 'Fix flaky login test', status: 'error', endedAt: 2_000 }, { now: NOW, lang: 'en-US' })
  assert.equal(enFail.label, 'Failed to fix flaky login test')
  assert.equal(rows.buildSubagentTaskRow({ ...base, task: 'Login is broken' }, { now: NOW, lang: 'en-US' }).label, 'Running: Login is broken')

  const titled = rows.buildSubagentTaskRow({ ...base, brief: { title: '检查依赖', goal: '长目标' } }, { now: NOW })
  assert.equal(titled.description, '检查依赖')
  assert.equal(titled.label, '正在检查依赖')
  const bareVerb = rows.buildSubagentTaskRow({ ...base, task: '调查' }, { now: NOW })
  assert.equal(bareVerb.label, '进行中：调查', '只有动词没有宾语时走通用前缀')
  const longTask = rows.buildSubagentTaskRow({ ...base, task: '甲'.repeat(200) }, { now: NOW })
  assert.equal([...longTask.description].length, 80)

  const stoppingRow = rows.buildSubagentTaskRow(base, { now: NOW, stopping: true })
  assert.equal(stoppingRow.state, 'stopping')
  assert.equal(stoppingRow.canStop, false)
  assert.equal(stoppingRow.label, '停止中：调查登录流程的并发问题')
  const stoppingDone = rows.buildSubagentTaskRow({ ...base, status: 'done', endedAt: 2000 }, { now: NOW, stopping: true })
  assert.equal(stoppingDone.state, 'done', '已结束的任务不再显示停止中')

  const offline = rows.buildSubagentTaskRow(base, { now: NOW, connection: 'disconnected' })
  assert.equal(offline.state, 'unknown')
  assert.equal(offline.canStop, false)
  assert.equal(offline.durationMs, null)
  const offlineDone = rows.buildSubagentTaskRow({ ...base, status: 'done', endedAt: 2000 }, { now: NOW, connection: 'disconnected' })
  assert.equal(offlineDone.state, 'done', '断连只影响运行中的任务')

  const lateStart = { ...base, status: 'starting', endedAt: undefined }
  const finished = { ...base, status: 'done', endedAt: 9_000 }
  assert.equal(rows.mergeSubagentRun(finished, lateStart).status, 'done', '迟到的启动确认不覆盖终态')
  assert.equal(rows.mergeSubagentRun(lateStart, finished).status, 'done')
  assert.equal(rows.mergeSubagentRun({ ...base, status: 'running' }, lateStart).status, 'running', '启动确认不把运行中退回启动中')
  assert.equal(rows.mergeSubagentRun(lateStart, { ...base, status: 'running' }).status, 'running')
  assert.equal(rows.mergeSubagentRun({ ...base, status: 'error', endedAt: 9_000 }, { ...base, status: 'done', endedAt: 5_000 }).status, 'error', '终态之间以较晚结束者为准')

  const merged = [
    rows.buildSubagentTaskRow(rows.mergeSubagentRun(lateStart, finished), { now: NOW }),
    rows.buildSubagentTaskRow({ ...base, id: 'sub-b2', startedAt: 5_000 }, { now: NOW }),
    rows.buildSubagentTaskRow({ ...base, id: 'sub-c3', startedAt: 3_000, status: 'running' }, { now: NOW, stopping: true })
  ]
  assert.deepEqual(merged.map((row) => [row.id, row.state]), [['sub-a1', 'done'], ['sub-b2', 'running'], ['sub-c3', 'stopping']], '逐条构建：重复 id 已由 merge 合并，停止中的任务可停止')
  assert.equal(merged.filter((row) => row.canStop).length, 1)

  const single = rows.buildSubagentTaskRow(base, { now: NOW, stopping: true })
  assert.equal(single.state, 'stopping')

  assert.equal(rows.subagentRowLabel('running', 'Investigate', 'en-US'), 'Running: Investigate', '单词型标题不重复词干')
  assert.equal(rows.subagentRowLabel('running', 'Investigate login flow', 'en-US'), 'Investigating login flow')

  console.log('test-subagent-task-rows: 通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
