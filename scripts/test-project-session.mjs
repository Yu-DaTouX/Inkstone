export function runProjectSessionTests(ok, mod) {
  const { pickProjectSession, sameCwd } = mod

  const A = 'C:\\work\\alpha'
  const B = 'C:\\work\\beta'
  const run = (o) => ({
    id: o.runId,
    runId: o.runId,
    cwd: o.cwd,
    projectId: o.projectId,
    sessionFile: o.file,
    generation: 1,
    running: false,
    waiting: false,
    failed: false,
    conn: 'ready',
    createdAt: 1,
    lastActiveAt: o.at,
    isActive: false
  })
  const sess = (o) => ({
    id: o.id,
    path: o.path,
    cwd: o.cwd,
    title: o.id,
    named: false,
    createdAt: 1,
    updatedAt: o.at,
    lastActivityAt: o.at,
    messageCount: 1,
    projectId: o.projectId,
    ...(o.opened !== undefined ? { lastOpenedAt: o.opened } : {})
  })

  ok(sameCwd('C:\\work\\alpha', 'c:/work/alpha/') === true, 'sameCwd 忽略分隔符、大小写与尾斜杠')
  ok(sameCwd('C:\\work\\alpha', 'C:\\work\\alpha2') === false, 'sameCwd 不做前缀匹配')
  ok(sameCwd(undefined, A) === false, 'sameCwd 对空值返回 false')

  const byRunner = pickProjectSession({
    cwd: A,
    runners: [run({ runId: 'r2', cwd: A, file: 'a-new.jsonl', at: 20 }), run({ runId: 'r1', cwd: A, file: 'a-old.jsonl', at: 10 })],
    sessions: [sess({ id: 's1', path: 'from-list.jsonl', cwd: A, at: 99 })]
  })
  ok(byRunner === 'a-new.jsonl', '有运行实例时用它最近活动的那个会话', String(byRunner))

  const byList = pickProjectSession({
    cwd: A,
    runners: [run({ runId: 'r9', cwd: B, file: 'b.jsonl', at: 30 })],
    sessions: [
      sess({ id: 's1', path: 'a-old.jsonl', cwd: A, at: 10 }),
      sess({ id: 's2', path: 'a-new.jsonl', cwd: A, at: 50 })
    ]
  })
  ok(byList === 'a-new.jsonl', '没有实例时从会话列表里取最近活动的那个', String(byList))

  const decorated = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [sess({ id: 's1', path: 'a.jsonl', cwd: A, at: 10, projectId: 'p-alpha' })]
  })
  ok(decorated === 'a.jsonl', '没给 projectId 时按 cwd 匹配，不排除已归属项目的会话', String(decorated))

  const strict = pickProjectSession({
    cwd: A,
    projectId: 'p-beta',
    runners: [run({ runId: 'r1', cwd: A, projectId: 'p-alpha', file: 'alpha.jsonl', at: 5 })],
    sessions: [
      sess({ id: 's1', path: 'alpha.jsonl', cwd: A, at: 5, projectId: 'p-alpha' }),
      sess({ id: 's2', path: 'beta.jsonl', cwd: A, at: 9, projectId: 'p-beta' })
    ]
  })
  ok(strict === 'beta.jsonl', '给了 projectId 时只认该归属的会话', String(strict))

  const none = pickProjectSession({ cwd: A, runners: [], sessions: [sess({ id: 's1', path: 'b.jsonl', cwd: B, at: 1 })] })
  ok(none === undefined, '该项目没有任何会话时返回 undefined（调用方新建）', String(none))

  const noFile = pickProjectSession({
    cwd: A,
    runners: [run({ runId: 'r1', cwd: A, file: undefined, at: 30 })],
    sessions: [sess({ id: 's1', path: 'a.jsonl', cwd: A, at: 5 })]
  })
  ok(noFile === 'a.jsonl', '实例还没有会话文件时退回会话列表', String(noFile))

  const byOpened = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [
      sess({ id: 'hot', path: 'hot.jsonl', cwd: A, at: 99 }),
      sess({ id: 'opened', path: 'opened.jsonl', cwd: A, at: 10, opened: 50 })
    ]
  })
  ok(byOpened === 'opened.jsonl', '打开过的会话优先于活动更新的会话（S3）', String(byOpened))

  const twoOpened = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [
      sess({ id: 'o1', path: 'o1.jsonl', cwd: A, at: 99, opened: 10 }),
      sess({ id: 'o2', path: 'o2.jsonl', cwd: A, at: 5, opened: 80 })
    ]
  })
  ok(twoOpened === 'o2.jsonl', '两条都打开过 → 比打开时间（不是比消息时间）', String(twoOpened))

  const noOpened = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [
      sess({ id: 'x1', path: 'x1.jsonl', cwd: A, at: 10 }),
      sess({ id: 'x2', path: 'x2.jsonl', cwd: A, at: 40 })
    ]
  })
  ok(noOpened === 'x2.jsonl', '没有打开记录时回落到活动时间（扫描推导仍能用）', String(noOpened))

  const mixed = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [
      sess({ id: 'never', path: 'never.jsonl', cwd: A, at: 999 }),
      sess({ id: 'was', path: 'was.jsonl', cwd: A, at: 1, opened: 5 })
    ]
  })
  ok(mixed === 'was.jsonl', '有打开记录的那条赢（不管活动时间）', String(mixed))

  const staleButMine = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [
      sess({ id: 'busy', path: 'busy.jsonl', cwd: A, at: 9_000_000 }),
      sess({ id: 'mine', path: 'mine.jsonl', cwd: A, at: 1_000, opened: 2_000 })
    ]
  })
  ok(staleButMine === 'mine.jsonl', '打开过（哪怕很早）仍优先于今天还在后台活动的会话', String(staleButMine))
}
