import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { reduceSessionRuntime } = await compile('src/renderer/src/state/session-runtime.ts')
  const runtime = { sessionId: 's', runId: 'r1', projectId: 'p', generation: 1 }
  const call = { id: 'c1', name: 'bash', args: { command: 'npm test' }, status: 'running', output: 'a' }
  let map = reduceSessionRuntime({}, runtime, { ch: 'sync', payload: [{ id: 'm1', role: 'assistant', text: '', toolCalls: [call] }] })
  map = reduceSessionRuntime(map, runtime, { ch: 'tool', payload: { msgId: 'm1', call: { id: 'c1', name: 'bash', status: 'running' }, outputDelta: 'b', sameArgs: true } })
  const merged = map.s.messages[0].toolCalls[0]
  ok(merged.output === 'ab' && merged.args?.command === 'npm test', '\u53c2\u6570\u672a\u53d8\u7684\u7cbe\u7b80\u8865\u4e01\u4fdd\u7559\u539f\u53c2\u6570\u5e76\u8ffd\u52a0\u8f93\u51fa', JSON.stringify(merged))
  const before = map.s.messages
  map = reduceSessionRuntime(map, runtime, { ch: 'tool', payload: { msgId: 'm1', call: { id: 'c2', name: 'bash', status: 'running' }, outputDelta: 'x', sameArgs: true } })
  ok(map.s.messages === before, '\u627e\u4e0d\u5230\u5bf9\u5e94\u5de5\u5177\u65f6\u4e22\u5f03\u7cbe\u7b80\u8865\u4e01\uff0c\u4e0d\u751f\u6210\u7f3a\u53c2\u6570\u7684\u5de5\u5177')
  map = reduceSessionRuntime(map, runtime, { ch: 'tool', payload: { msgId: 'm1', call: { id: 'c3', name: 'bash', args: { command: 'ls' }, status: 'running' }, outputDelta: 'y' } })
  ok(map.s.messages[0].toolCalls.some((item) => item.id === 'c3' && item.output === 'y'), '\u5b8c\u6574\u8865\u4e01\u4ecd\u53ef\u65b0\u5efa\u5de5\u5177')
})
