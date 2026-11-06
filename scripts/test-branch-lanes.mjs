import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const node = (id, parentId, role, content, children = [], extra = {}) => ({
  entry: { id, parentId, type: 'message', message: { role, content, ...(role === 'toolResult' ? { toolName: 'read' } : {}) } },
  children,
  ...extra
})

export async function runBranchLaneTests(ok) {
  await build({ entryPoints: ['src/shared/branch-lanes.ts'], outfile: 'out/test/branch-lanes.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { buildBranchLanes } = await import(pathToFileURL('out/test/branch-lanes.mjs').href + `?v=${Date.now()}`)

  const fork = [node('u1', null, 'user', 'hello', [
    node('a1', 'u1', 'assistant', 'hi', [
      node('t1', 'a1', 'toolResult', 'x'),
      node('u2', 'a1', 'user', 'side', [node('b1', 'u2', 'assistant', 'side answer')]),
      node('a2', 'a1', 'assistant', 'again')
    ])
  ])]
  const view = buildBranchLanes(fork, 'a2')
  ok(view.rows.map((r) => r.entryId).join() === 'u1,t1,u2,a2', '只保留用户消息、分叉后的分支起点与当前位置，当前分支排在最后')
  const byId = Object.fromEntries(view.rows.map((r) => [r.entryId, r]))
  ok(byId.u1.targetId === 'a1' && byId.u1.steps === 1 && byId.u1.fork, '用户消息吸收后续助手步骤，切换目标是这一段的末尾')
  ok(byId.u2.targetId === 'b1' && byId.u2.steps === 1, '旁支的切换目标是旁支末尾')
  ok(byId.u1.lane === 0 && byId.a2.lane === 0 && byId.a2.leaf && byId.a2.active, '当前分支固定在第 0 列')
  ok(byId.t1.lane === 1 && byId.u2.lane === 2 && view.lanes === 3, '分叉出去的旁支各占一列，跨过别的旁支时不共用列')
  ok(view.edges.length === 3 && view.edges.every((e) => e.from === 0), '每个分支起点都连回分叉点')
  ok(view.edges.find((e) => e.to === 3).active && !view.edges.find((e) => e.to === 2).active, '只有当前分支上的连线是活动的')

  const linear = [node('u1', null, 'user', 'a', [node('a1', 'u1', 'assistant', 'b', [node('u2', 'a1', 'user', 'c', [node('a2', 'u2', 'assistant', 'd')])])])]
  const flat = buildBranchLanes(linear, 'a2')
  ok(flat.rows.length === 2 && flat.lanes === 1 && flat.rows[1].targetId === 'a2' && flat.rows[1].leaf, '没有分叉时是一列，每轮一行')

  const back = buildBranchLanes(linear, 'a1')
  ok(back.rows.map((r) => r.entryId).join() === 'u1,u2' && back.rows[0].targetId === 'a1' && back.rows[0].leaf && !back.rows[1].active, '回到早先位置时当前段在当前位置截断，后面的部分不算当前分支')

  const sequential = [node('u1', null, 'user', 'root', [
    node('x1', 'u1', 'user', 'first try', [node('x2', 'x1', 'assistant', 'r1')]),
    node('y1', 'u1', 'user', 'second try', [node('y2', 'y1', 'assistant', 'r2')]),
    node('z1', 'u1', 'user', 'third try', [node('z2', 'z1', 'assistant', 'r3')])
  ])]
  const tries = buildBranchLanes(sequential, 'z2')
  const lanes = Object.fromEntries(tries.rows.map((r) => [r.entryId, r.lane]))
  ok(lanes.z1 === 0 && lanes.x1 === 1 && lanes.y1 === 2, '同一分叉的多次重试依次向右排开')
  ok(buildBranchLanes([], null).rows.length === 0, '空树没有行')
  const meta = (id, parentId, children = []) => ({ entry: { id, parentId, type: 'model_change', provider: 'fake', modelId: 'm' }, children })
  ok(buildBranchLanes([meta('m0', null)], 'm0').rows.length === 0, '只有模型信息的新会话没有行')
  const withPreamble = buildBranchLanes([meta('m0', null, [meta('m1', 'm0', linear)])], 'a2')
  ok(withPreamble.rows[0].entryId === 'u1' && withPreamble.rows.length === 2, '会话开头的模型与档位记录不单独成行')
  const renamed = [node('u1', null, 'user', 'a', [
    { entry: { id: 'i1', parentId: 'u1', type: 'session_info', name: 'title' }, children: [] },
    node('a1', 'u1', 'assistant', 'b', [node('u2', 'a1', 'user', 'c')])
  ])]
  const noisy = buildBranchLanes(renamed, 'u2')
  ok(noisy.rows.length === 2 && noisy.lanes === 1 && !noisy.rows[0].fork && noisy.rows[0].targetId === 'a1', '只含改名记录的旁枝不画，也不算分叉')
  ok(buildBranchLanes(renamed, 'i1').rows.some((r) => r.entryId === 'i1' && r.leaf), '当前位置落在改名记录上时仍然显示')
  const renamedSide = [node('u1', null, 'user', 'a', [
    { entry: { id: 'i1', parentId: 'u1', type: 'session_info', name: 'title' }, children: [node('s1', 'i1', 'user', 'side')] },
    node('a1', 'u1', 'assistant', 'b')
  ])]
  const side = buildBranchLanes(renamedSide, 'a1')
  ok(side.rows.map((r) => r.entryId).join() === 'u1,s1,a1', '旁枝开头的改名记录跳过，旁枝从用户消息开始')

  const a = node('a', null, 'user', 'x')
  const b = node('b', 'a', 'assistant', 'y')
  a.children.push(b)
  b.children.push(a)
  ok(buildBranchLanes([a], 'b').rows.length === 1, '环状数据不会死循环')
  const m1 = meta('m1', null)
  const m2 = meta('m2', 'm1')
  m1.children.push(m2)
  m2.children.push(m1)
  ok(buildBranchLanes([m1], null).rows.length === 0, '只有元信息的环也不会死循环')

  let deep = node('leaf', 'n2999', 'user', 'last')
  for (let i = 2999; i >= 0; i -= 1) deep = node(`n${i}`, i ? `n${i - 1}` : null, i % 2 ? 'assistant' : 'user', `t${i}`, [deep])
  const started = Date.now()
  const long = buildBranchLanes([deep], 'leaf')
  ok(long.rows.length === 1501 && long.lanes === 1 && long.rows.at(-1).leaf, '3000 层深链按轮成行，叶子在最后')
  ok(Date.now() - started < 1000, '深链布局在 1 秒内完成', Date.now() - started)
}

if (process.argv[1]?.endsWith('test-branch-lanes.mjs')) {
  let passed = 0, failed = 0
  await runBranchLaneTests((value, name) => { if (value) passed++; else { failed++; console.error('FAIL', name) } })
  console.log(`${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
