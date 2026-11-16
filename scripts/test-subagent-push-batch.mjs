import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createSubagentPushBatch } = await compile('src/main/subagent-push-batch.ts')
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const make = () => {
    const pushes = []
    const remote = []
    const batch = createSubagentPushBatch({ push: (msg) => pushes.push(msg), publishRemote: (msg) => remote.push(msg) })
    return { batch, pushes, remote }
  }
  const run = (id, status = 'running', extra = {}) => ({ id, status, task: `task-${id}`, brief: 'b', ...extra })
  const patch = (id, from, extra = {}) => ({ id, run: run(id, 'running', extra), transcriptFrom: from })

  const a = make()
  a.batch.change(run('r1'))
  a.batch.change(run('r1', 'running', { step: 2 }))
  ok(a.pushes.length === 0, '运行中的变化先攒着，不立即推送')
  await wait(220)
  ok(a.pushes.length === 1 && a.pushes[0].ch === 'subagent' && a.pushes[0].payload.step === 2, '150ms 后合并成一条最新状态')
  ok(a.pushes[0].payload.task === 'task-r1', '首次推送带完整任务文本')
  a.batch.change(run('r1', 'done'))
  ok(a.pushes.length === 2 && !('task' in a.pushes[1].payload) && !('brief' in a.pushes[1].payload), '结束状态立即推送，已发过的任务文本不再重复')

  const b = make()
  b.batch.change(run('r2'), patch('r2', 0))
  b.batch.change(run('r2'), patch('r2', 3))
  await wait(220)
  ok(b.pushes.length === 2 && b.pushes.every((msg) => msg.ch === 'subagent-patch') && b.pushes[1].payload.transcriptFrom === 3, '只有增量时按顺序推送补丁')
  ok(b.pushes.every((msg) => !('task' in msg.payload.run)), '补丁里去掉任务文本')
  ok(b.remote.length === 1 && b.remote[0].ch === 'subagent' && b.remote[0].payload.task === 'task-r2', '远程端收到一条完整运行')

  const c = make()
  c.batch.change(run('r3'), patch('r3', 0))
  c.batch.change(run('r3'))
  await wait(220)
  ok(c.pushes.length === 1 && c.pushes[0].ch === 'subagent', '中途出现整条变化时改推整条，不再推补丁')

  const d = make()
  d.batch.change(run('r4'))
  d.batch.patch(patch('r4', 5))
  ok(d.pushes.length === 2 && d.pushes[0].ch === 'subagent' && d.pushes[1].ch === 'subagent-patch', '直接补丁先冲掉积压的整条再推')

  const e = make()
  e.batch.change(run('r5'))
  e.batch.remove('r5')
  ok(e.pushes.length === 1 && e.pushes[0].ch === 'subagent-remove' && e.pushes[0].payload === 'r5', '删除时丢掉积压内容并推送删除')
  e.batch.change(run('r5', 'done'))
  ok(e.pushes[1].payload.task === 'task-r5', '删除后同 id 再出现时重新带完整任务文本')
  await wait(200)
  ok(e.pushes.length === 2, '删除后计时器不再补推')
})
