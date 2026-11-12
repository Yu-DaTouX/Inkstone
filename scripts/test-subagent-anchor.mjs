#!/usr/bin/env node
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { subagentAnchorIds, cachedSubagentAnchors } = await compile('src/renderer/src/features/session/subagent-list.ts')
  const live = [
    { id: 'm0', role: 'user', timestamp: 1_000 },
    { id: 'm1', role: 'assistant', timestamp: 2_000 },
    { id: 'm2', role: 'assistant', timestamp: 3_000 },
    { id: 'm3', role: 'user', timestamp: 10_000 },
    { id: 'm4', role: 'assistant', timestamp: 11_000 }
  ]
  const run = { id: 'sub-a', parentMessageId: 'm1', startedAt: 2_500 }
  ok(subagentAnchorIds(live, [run]).get('sub-a') === 'm1', '原 id 与启动时间同在一轮时保留原锚点')

  const reloaded = [
    { id: 'm0', role: 'user', timestamp: 1_000 },
    { id: 'm1', role: 'assistant', timestamp: 3_000 },
    { id: 'm2', role: 'user', timestamp: 10_000 },
    { id: 'm3', role: 'assistant', timestamp: 11_000 },
    { id: 'm4', role: 'user', timestamp: 20_000 },
    { id: 'm5', role: 'assistant', timestamp: 21_000 }
  ]
  const shifted = { id: 'sub-b', parentMessageId: 'm5', startedAt: 3_500 }
  ok(subagentAnchorIds(reloaded, [shifted]).get('sub-b') === 'm1', '重新加载后编号错位：不挂到后面的轮次，按启动时间回到原来那一轮')
  const vanished = { id: 'sub-c', parentMessageId: 'm612', startedAt: 11_500 }
  ok(subagentAnchorIds(reloaded, [vanished]).get('sub-c') === 'm3', '原 id 已不存在时按启动时间找回所在轮次')
  const idle = { id: 'sub-d', parentMessageId: 'm5', startedAt: 60_000 }
  ok(subagentAnchorIds(reloaded, [idle]).get('sub-d') === 'm5', '空闲时发起的旁路快问挂在最近一条回复下')
  const sameTurnLater = { id: 'sub-e', parentMessageId: 'm2', startedAt: 2_100 }
  ok(subagentAnchorIds(live, [sameTurnLater]).get('sub-e') === 'm2', '同一轮内稍后的消息仍算原锚点（启动时间允许少量误差）')
  ok(!subagentAnchorIds(live, [{ id: 'sub-f', startedAt: 2_500 }]).has('sub-f'), '没有父消息的子代理不额外挂到时间线上')
  ok(subagentAnchorIds([{ id: 'm0', role: 'user' }], [run]).get('sub-a') === 'm1', '消息没有时间戳时保留原 id')

  const runs = [run]
  const first = cachedSubagentAnchors(live, runs)
  ok(cachedSubagentAnchors(live, runs) === first && cachedSubagentAnchors([...live], runs) !== first, '同一份消息和子代理列表只计算一次')
})
