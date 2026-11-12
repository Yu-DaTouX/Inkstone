import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const rel = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))

await runSuite(import.meta.url, async (ok, compile) => {
  const { buildBranchLanes } = await compile(rel('src/shared/branch-lanes.ts'))
  const { slimNativeEntry, nativeTreeFromFlat, flattenNativeTree } = await compile(rel('src/shared/native-session.ts'))
  const { buildSubagentNotice } = await compile(rel('src/shared/subagent-notice.ts'))
  const { buildTerminalNotice } = await compile(rel('src/shared/host-notice-text.ts'))

  const notice = buildSubagentNotice({ id: 'sub-616c1412', task: '审查分支', status: 'done', isolation: 'worktree', result: { summary: '完成', fullText: '完成' } })
  const terminal = buildTerminalNotice({ id: 'term-1', command: 'npm test', state: 'completed', seconds: 3, output: 'ok', truncated: false, since: 0 })
  const raw = (id, parentId, role, content, children = []) => ({ entry: { id, parentId, type: 'message', message: { role, content } }, children })
  const nested = [raw('u1', null, 'user', '先合并一下工作树的分支吧', [
    raw('a1', 'u1', 'assistant', '好的', [
      raw('n1', 'a1', 'user', [{ type: 'text', text: notice }], [
        raw('a2', 'n1', 'assistant', '收到', [
          raw('n2', 'a2', 'user', terminal, [
            raw('a3', 'n2', 'assistant', '命令结束', [
              raw('u2', 'a3', 'user', '开始审查吧', [raw('a4', 'u2', 'assistant', '开始')])
            ])
          ])
        ])
      ])
    ])
  ])]
  const flat = flattenNativeTree(nested)
  const slim = Object.fromEntries(flat.map((node) => [node.entry.id, node.entry]))
  ok(slim.n1.message.hostNotice === 'subagent' && slim.n2.message.hostNotice === 'terminal', '瘦身时按完整原文识别子代理回传与终端通知', JSON.stringify([slim.n1.message, slim.n2.message]))
  ok(slim.u1.message.hostNotice === undefined && slim.u2.message.hostNotice === undefined, '用户自己的提问不打宿主标记')
  ok(slimNativeEntry({ id: 'x', type: 'message', message: { role: 'assistant', content: notice } }).message.hostNotice === undefined, '只看用户角色的消息')

  const tree = nativeTreeFromFlat(flat)
  const lanes = buildBranchLanes(tree, 'a4')
  ok(lanes.rows.map((row) => row.entryId).join() === 'u1,u2', '宿主通知不作锚点，只剩用户提问两行', lanes.rows.map((row) => row.entryId).join())
  const first = lanes.rows[0]
  ok(first.steps === 5 && first.targetId === 'a3', '通知并入前一用户行的步数', JSON.stringify(first))
  ok(lanes.rows[1].leaf && !first.leaf, '当前标记仍在真正的最后一轮')

  const atNotice = buildBranchLanes(tree, 'n1')
  const leafRow = atNotice.rows.find((row) => row.leaf)
  ok(leafRow && leafRow.entryId === 'u1' && leafRow.targetId === 'n1', '叶子停在通知上时由前一用户行承接，不把通知标成当前')

  const forked = nativeTreeFromFlat(flattenNativeTree([raw('u1', null, 'user', 'q', [
    raw('a1', 'u1', 'assistant', 'r', [
      raw('n1', 'a1', 'user', notice, [raw('a2', 'n1', 'assistant', 'x')]),
      raw('u3', 'a1', 'user', '换个方向', [raw('a3', 'u3', 'assistant', 'y')])
    ])
  ])]))
  const fork = buildBranchLanes(forked, 'a3')
  const hostRow = fork.rows.find((row) => row.entryId === 'n1')
  ok(hostRow && hostRow.host === 'subagent', '分叉点后必须成行的通知带短标签类型，界面不显示原文', JSON.stringify(hostRow))
})
