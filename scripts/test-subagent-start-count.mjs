import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const rel = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))

await runSuite(import.meta.url, async (ok, compile) => {
  const { subagentStartCount, summarizeToolRun, formatToolRun, toolTally } = await compile(rel('src/renderer/src/features/session/tool-run-model.ts'))
  const started = (id) => JSON.stringify({ ok: true, summary: { kind: 'subagent', action: 'start', id, status: 'running' } })
  const loop = {
    id: 'c1',
    name: 'bash',
    status: 'done',
    args: { command: 'for i in $(seq 1 3); do yan subagent start --task "t$i" --title "压测$i"; done' },
    output: [started('sub-00000001'), started('sub-00000002'), started('sub-00000003')].join('\n')
  }
  ok(subagentStartCount(loop) === 3, '循环里派出的子代理按实际启动结果计数')
  ok(subagentStartCount({ ...loop, output: '' }) === 1, '还没有输出时至少记 1 个')
  const chained = { ...loop, args: { command: 'yan subagent start --task a && yan subagent start --task b' }, output: started('sub-00000001') }
  ok(subagentStartCount(chained) === 2, '命令里写了几个按几个算，取两者较大值')
  const tt = (key, vars) => `${key}${vars?.n ?? ''}`
  const line = formatToolRun(summarizeToolRun([loop]), tt)
  ok(line.toLowerCase().includes('runagent3'), '工具行写派出 3 个', line)
  ok(toolTally([loop])[0].count === 3, '工具计数也按实际个数')
})
