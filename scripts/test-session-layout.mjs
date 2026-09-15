/**
 * SessionLayoutStore 的纯 Node 测试。
 * 验证“产品归属”和 pi JSONL 物理路径分离、旧会话迁移、pending 冲突、移动历史
 * 以及并发写入串行化。
 */
export async function runSessionLayoutTests(ok, api) {
  const project = (id, cwd) => ({
    id,
    cwd,
    name: id,
    archived: false,
    createdAt: 1,
    updatedAt: 1
  })
  const summary = (id, path, cwd) => ({
    id,
    path,
    cwd,
    title: id,
    named: false,
    createdAt: 10,
    updatedAt: 10,
    messageCount: 1
  })

  console.log('\n--- 项目/会话归属（SessionLayoutStore）---')
  const projects = [project('project-a', 'C:/work/app'), project('project-b', 'C:/work/other')]
  let decorated = await api.decorateSessions(
    [summary('session-a', 'C:/yan/sessions/a.jsonl', 'c:\\work\\app')],
    projects
  )
  ok(decorated[0].projectId === 'project-a' && decorated[0].scope === 'project', '旧会话按唯一 cwd 迁移到项目归属')
  ok(decorated[0].path === 'C:/yan/sessions/a.jsonl', '迁移只写语义索引，不改变 JSONL 物理路径')

  let document = await api.getSessionLayout()
  ok(document.version === 1 && document.entries.some((item) => item.sessionId === 'session-a'), '迁移记录持久化到 session-layout')

  const global = await api.rememberSession({
    sessionId: 'session-global',
    sessionFile: 'C:/yan/sessions/global.jsonl',
    cwd: 'C:/work/app',
    scope: 'global'
  })
  ok(global.scope === 'global' && !global.projectId, '全局会话不因 cwd 命中项目而被强行归属')

  const moved = await api.moveSessionLayout(
    { sessionId: 'session-global', sessionFile: global.sessionFile, cwd: global.cwd },
    'project-a'
  )
  ok(moved.projectId === 'project-a' && moved.scope === 'project', '移动会话只更新 projectId 和 scope')
  ok(moved.sessionFile === global.sessionFile && moved.moveHistory.length === 1, '移动保留物理路径并追加移动历史')

  decorated = await api.decorateSessions(
    [summary('session-conflict', 'C:/yan/sessions/conflict.jsonl', 'C:\\work\\app')],
    [project('project-a', 'C:/work/app'), project('project-duplicate', 'c:\\work\\app')]
  )
  ok(decorated[0].scope === 'pending', '多个同 cwd 项目保留 pending，不静默选择')
  ok(decorated[0].projectCandidates?.length === 2, 'pending 会话保留全部项目候选')

  await Promise.all([
    api.rememberSession({ sessionId: 'parallel-a', cwd: 'C:/a', scope: 'global' }),
    api.rememberSession({ sessionId: 'parallel-b', cwd: 'C:/b', scope: 'global' })
  ])
  document = await api.getSessionLayout()
  ok(
    document.entries.some((item) => item.sessionId === 'parallel-a') && document.entries.some((item) => item.sessionId === 'parallel-b'),
    '并发归属写入串行化，不丢任一会话记录'
  )
}

