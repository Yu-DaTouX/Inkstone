import assert from 'node:assert/strict'

export function runOutlineTurnTests(ok, { createOutlineProjector }) {
  const project = createOutlineProjector()
  const user = { id: 'u', role: 'user', text: '提问', timestamp: 10 }
  const reply = { id: 'a', role: 'assistant', text: '正文', toolCalls: [{ id: 'call', name: 'read', status: 'done' }] }
  const rows = [user, reply]
  const initial = project(rows)
  ok(initial.length === 1 && initial[0].msgId === 'u' && initial[0].index === 0, '导航沿用用户回合身份和下标')
  ok(initial[0].steps === 1 && initial[0].timestamp === 10 && !initial[0].failed, '导航保留工具数与时间')
  ok(project([...rows])[0] === initial[0], '相同消息引用复用导航摘要')
  const live = [...rows, { id: 'u2', role: 'user', text: '第二问' }, { id: 'a2', role: 'assistant', text: '中文🖋️' }]
  const next = project(live, 'a2')
  ok(next[0] === initial[0] && next[1].assistant === '中文🖋️', '流式只更新当前导航摘要')
  const final = project(live)
  ok(final[1].assistant === '中文🖋️' && final[0] === initial[0], '完成时正文完整且历史摘要不重建')
  const edited = project([{ ...user, text: '历史问题已编辑' }, { ...reply, text: '历史答案已编辑' }])
  ok(edited[0].user === '历史问题已编辑' && edited[0].assistant === '历史答案已编辑', '历史编辑以新消息引用失效缓存')
  const failed = project([user, { ...reply, error: '失败' }])
  ok(failed[0].failed, '助手失败进入导航标记')
  const cancelled = project([user, { ...reply, toolCalls: [{ id: 'call', name: 'read', status: 'error', cancelled: true }] }])
  ok(!cancelled[0].failed, '用户取消工具不误标失败')
  const removed = project(live.slice(2))
  ok(removed.length === 1 && removed[0].index === 0 && removed[0].msgId === 'u2', '历史裁剪后索引重排')
  const separated = project([user, { id: 'bash', role: 'bash', text: '命令' }, reply])
  ok(separated[0].assistant === '' && separated[0].steps === 0, 'bash隔开回复时不跨回合取正文')
  const consecutive = project([user, { id: 'u2', role: 'user', text: '连续问题' }])
  ok(consecutive.length === 2 && consecutive[0].assistant === '' && consecutive[1].index === 1, '连续用户消息不合并或错位')
  assert.deepEqual(project([]), [])
  ok(true, '空会话清除旧导航结果')
  const other = project([{ ...user, text: '同id另一会话' }])
  ok(other[0].user === '同id另一会话' && other[0].assistant === '', '同id的新会话不复用旧摘要')
}
