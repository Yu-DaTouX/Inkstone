import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { sameProcessGroupProps, sameSegment } = await compile(join(resolve('.'), 'src/renderer/src/features/session/process-group-props.ts'))
  const call = (id, extra = {}) => ({ id, name: 'bash', args: { command: id }, status: 'ok', output: 'ok', ...extra })
  const tools = [call('t1'), call('t2')]
  const segment = (overrides = {}) => ({
    id: 's1', sourceMessageId: 'm1', runId: null, thinking: '想', thinkingLive: false, thinkingParts: [{ text: '想', at: 0 }],
    tools, texts: [{ id: 'm1', text: '叙述', hasTools: true }], response: null, commentary: [], ...overrides
  })
  const props = (overrides = {}) => ({
    segments: [segment()], groupKey: 'group:s1', live: false, openByDefault: false, alertFailures: true, showFailures: true,
    liveStartedAt: null, view: 'concise', approvalIds: new Set(), glowId: null, compactionAfter: null, ...overrides
  })

  ok(sameSegment(segment(), segment({ thinkingParts: [{ text: '想', at: 0 }] })), '\u91cd\u65b0\u6295\u5f71\u51fa\u7684\u540c\u5185\u5bb9\u6bb5\uff08\u65b0\u5bf9\u8c61\u3001\u540c\u4e00\u6279\u5de5\u5177\u8c03\u7528\uff09\u89c6\u4e3a\u76f8\u540c')
  ok(sameSegment(segment(), segment({ tools: tools.map((item) => ({ ...item })) })), '\u5de5\u5177\u8c03\u7528\u5bf9\u8c61\u91cd\u5efa\u4f46\u5b57\u6bb5\u5f15\u7528\u76f8\u540c\u65f6\u89c6\u4e3a\u76f8\u540c')
  ok(!sameSegment(segment(), segment({ tools: [tools[0], { ...tools[1], status: 'running' }] })), '\u5de5\u5177\u72b6\u6001\u53d8\u5316\u65f6\u4e0d\u540c')
  ok(!sameSegment(segment(), segment({ tools: [tools[0], { ...tools[1], output: 'ok more' }] })), '\u5de5\u5177\u8f93\u51fa\u53d8\u5316\u65f6\u4e0d\u540c')
  ok(!sameSegment(segment(), segment({ tools: [...tools, call('t3')] })), '\u65b0\u589e\u5de5\u5177\u65f6\u4e0d\u540c')
  ok(!sameSegment(segment(), segment({ thinking: '想多了' })), '\u601d\u8003\u6587\u672c\u53d8\u5316\u65f6\u4e0d\u540c')
  ok(!sameSegment(segment(), segment({ thinkingLive: true })), '\u601d\u8003\u8fdb\u884c\u72b6\u6001\u53d8\u5316\u65f6\u4e0d\u540c')
  ok(!sameSegment(segment(), segment({ thinkingParts: [{ text: '想', at: 1 }] })), '\u601d\u8003\u7247\u6bb5\u4f4d\u7f6e\u53d8\u5316\u65f6\u4e0d\u540c')
  ok(!sameSegment(segment(), segment({ commentary: [{ id: 'n1', text: '\u65c1\u767d', hasTools: true }] })), '\u65c1\u767d\u53d8\u5316\u65f6\u4e0d\u540c')
  ok(sameSegment(segment(), segment({ texts: [{ id: 'm1', text: '\u53d9\u8ff0\u7ee7\u7eed\u8f93\u51fa', hasTools: false }], response: { id: 'm1', text: '\u56de\u590d', hasTools: false } })), '\u8fc7\u7a0b\u7ec4\u4e0d\u6e32\u67d3\u7684 texts \u4e0e response \u53d8\u5316\u4e0d\u89e6\u53d1\u91cd\u6e32\u67d3')

  ok(sameProcessGroupProps(props(), props({ segments: [segment()] })), '\u5185\u5bb9\u76f8\u540c\u7684\u5c5e\u6027\u89c6\u4e3a\u76f8\u540c')
  ok(sameProcessGroupProps(props({ glowId: 'x1' }), props({ glowId: 'x2' })), '\u53d1\u5149\u7684\u5de5\u5177\u4e0d\u5728\u672c\u7ec4\u65f6\u5ffd\u7565 glowId \u53d8\u5316')
  ok(sameProcessGroupProps(props({ glowId: null }), props({ glowId: 'x2' })), '\u4ece\u65e0\u5230\u6709\u4f46\u4e0d\u5728\u672c\u7ec4\u65f6\u540c\u6837\u5ffd\u7565')
  ok(!sameProcessGroupProps(props({ glowId: null }), props({ glowId: 't2' })), '\u53d1\u5149\u79fb\u5230\u672c\u7ec4\u7684\u5de5\u5177\u65f6\u91cd\u6e32\u67d3')
  ok(!sameProcessGroupProps(props({ glowId: 't1' }), props({ glowId: 'x9' })), '\u53d1\u5149\u79bb\u5f00\u672c\u7ec4\u65f6\u91cd\u6e32\u67d3')
  ok(!sameProcessGroupProps(props({ glowId: undefined }), props({ glowId: 'x9' })), 'glowId \u4ece\u672a\u4f20\uff08\u7ec4\u5185\u81ea\u7b97\uff09\u53d8\u4e3a\u663e\u5f0f\u503c\u65f6\u91cd\u6e32\u67d3')
  ok(sameProcessGroupProps(props({ approvalIds: new Set(['a']) }), props({ approvalIds: new Set(['a']) })), '\u5ba1\u6279\u96c6\u5408\u5185\u5bb9\u76f8\u540c\u89c6\u4e3a\u76f8\u540c')
  ok(!sameProcessGroupProps(props({ approvalIds: new Set(['a']) }), props({ approvalIds: new Set(['b']) })), '\u5ba1\u6279\u96c6\u5408\u53d8\u5316\u65f6\u91cd\u6e32\u67d3')
  ok(sameProcessGroupProps(props({ compactionAfter: { messageId: 'm1', toolId: null } }), props({ compactionAfter: { messageId: 'm1', toolId: null } })), '\u538b\u7f29\u5207\u70b9\u5185\u5bb9\u76f8\u540c\u89c6\u4e3a\u76f8\u540c')
  ok(!sameProcessGroupProps(props({ compactionAfter: null }), props({ compactionAfter: { messageId: 'm1', toolId: 't1' } })), '\u538b\u7f29\u5207\u70b9\u53d8\u5316\u65f6\u91cd\u6e32\u67d3')
  for (const [key, value] of [['live', true], ['openByDefault', true], ['alertFailures', false], ['showFailures', false], ['liveStartedAt', 5], ['view', 'thinking'], ['groupKey', 'group:s2']]) {
    ok(!sameProcessGroupProps(props(), props({ [key]: value })), `${key} \u53d8\u5316\u65f6\u91cd\u6e32\u67d3`)
  }
  ok(!sameProcessGroupProps(props({ segments: [segment()] }), props({ segments: [segment(), segment({ id: 's2' })] })), '\u6bb5\u6570\u53d8\u5316\u65f6\u91cd\u6e32\u67d3')
  ok(!sameProcessGroupProps(props(), props({ extra: 1 })), '\u672a\u5217\u51fa\u7684\u65b0\u5c5e\u6027\u6309\u5f15\u7528\u6bd4\u8f83\uff0c\u4e0d\u4f1a\u88ab\u5ffd\u7565')
})
