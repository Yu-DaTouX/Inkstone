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

  /* 归档与置顶：只在显式传入时变，其余写入（打开、移动）原样带过 */
  const base = await api.rememberSession({ sessionId: 'flag-a', sessionFile: 'C:/yan/sessions/flag-a.jsonl', cwd: 'C:/work/app', projectId: 'project-a', scope: 'project' })
  ok(!base.archivedAt && !base.pinned, '新会话默认未归档、未置顶')
  const archived = await api.setSessionFlags({ sessionId: 'flag-a', sessionFile: base.sessionFile, cwd: base.cwd }, { archived: true })
  ok(archived.archivedAt > 0 && archived.projectId === 'project-a' && archived.scope === 'project', '归档只写标记，项目归属原样保留')
  const pinned = await api.setSessionFlags({ sessionId: 'flag-a', sessionFile: base.sessionFile, cwd: base.cwd }, { pinned: true })
  ok(pinned.pinned === true && pinned.archivedAt === archived.archivedAt, '置顶不改归档时间')
  const reopened = await api.rememberSession({ sessionId: 'flag-a', cwd: 'C:/work/app', projectId: 'project-a', scope: 'project' })
  ok(reopened.pinned === true && reopened.archivedAt === archived.archivedAt, '再次打开会话不会清掉归档与置顶')
  const movedFlag = await api.moveSessionLayout({ sessionId: 'flag-a', sessionFile: base.sessionFile, cwd: base.cwd }, 'project-b')
  ok(movedFlag.pinned === true && !!movedFlag.archivedAt, '移动到别的项目不会清掉归档与置顶')
  const back = await api.setSessionFlags({ sessionId: 'flag-a', sessionFile: base.sessionFile, cwd: base.cwd }, { archived: false, pinned: false })
  ok(!back.archivedAt && !back.pinned, '取消归档与置顶后标记清除')
  const projected = await api.decorateSessions([{ ...summary('flag-a', base.sessionFile, 'C:/work/app') }], projects)
  ok(projected[0].archivedAt === undefined && projected[0].pinned === undefined, '取消后列表投影里也没有这两个字段')

  await api.setSessionFlags({ sessionId: 'flag-a', sessionFile: base.sessionFile, cwd: base.cwd }, { pinned: true })
  await api.rememberSession({ sessionId: 'flag-b', cwd: 'C:/work/app', scope: 'global' })
  const n = await api.archiveSessionsBatch(['flag-a', 'flag-b', 'no-such'])
  ok(n === 2, '批量归档只计真正改变的条目（未知 id 跳过）')
  ok((await api.archiveSessionsBatch(['flag-b'])) === 0, '已归档的再批量归档不重复写入')
  const afterBatch = (await api.getSessionLayout()).entries.find((e) => e.sessionId === 'flag-a')
  ok(afterBatch.pinned === true && !!afterBatch.archivedAt, '批量归档不动其他标记')
}

