import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { SubagentController } = await compile('src/main/subagents.ts')
  const controller = Object.create(SubagentController.prototype)
  const finished = (index, extra = {}) => ({ id: `run-${index}`, status: 'done', notified: true, reviewDecided: true, worktreeDone: true, review: 'none', startedAt: index, endedAt: index, ...extra })
  const runs = []
  for (let index = 0; index < 210; index++) runs.push(finished(index))
  runs.push(finished(-1, { id: 'pending-review', review: 'pending' }))
  runs.push(finished(-2, { id: 'running', status: 'running' }))
  runs.push(finished(-3, { id: 'no-history' }))
  controller.runs = new Map(runs.map((run) => [run.id, run]))
  controller.pushedTranscript = new Map()
  controller.resuming = new Map()
  controller.reviewing = new Set()
  controller.history = { get: (id) => (id === 'no-history' ? undefined : { run: { id } }) }
  controller.trimFinished()
  ok(!controller.runs.has('run-0') && !controller.runs.has('run-9'), '超出 200 条时先移出最早结束的子代理')
  ok(controller.runs.has('run-10') && controller.runs.has('run-209'), '最近 200 条已结束子代理留在内存')
  ok(controller.runs.has('pending-review') && controller.runs.has('running') && controller.runs.has('no-history'), '待审、运行中、没有历史记录的子代理不移出')
})
