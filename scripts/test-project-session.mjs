/**
 * 切项目时「该项目最近访问的会话」的选法（N05，`src/renderer/src/state/project-session.ts`）。
 *
 * 为什么要单测：它是切项目的唯一决策点，选错就落到 `newSession` ——
 * 新会话 = 新 sessionId，而草稿是按 sessionId 存在运行时缓存里的，用户的草稿直接没了。
 * 这里的组合（只有运行实例 / 只有会话列表 / projectId 匹配与否 / Windows 路径大小写）
 * 用真实窗口很难穷举，纯逻辑里一次钉死。
 */
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
    projectId: o.projectId
  })

  ok(sameCwd('C:\\work\\alpha', 'c:/work/alpha/') === true, 'sameCwd 忽略分隔符、大小写与尾斜杠')
  ok(sameCwd('C:\\work\\alpha', 'C:\\work\\alpha2') === false, 'sameCwd 不做前缀匹配')
  ok(sameCwd(undefined, A) === false, 'sameCwd 对空值返回 false')

  /* ① 运行实例优先：它带着会话文件，是“刚才在看哪个会话”最直接的证据 */
  const byRunner = pickProjectSession({
    cwd: A,
    runners: [run({ runId: 'r2', cwd: A, file: 'a-new.jsonl', at: 20 }), run({ runId: 'r1', cwd: A, file: 'a-old.jsonl', at: 10 })],
    sessions: [sess({ id: 's1', path: 'from-list.jsonl', cwd: A, at: 99 })]
  })
  ok(byRunner === 'a-new.jsonl', '有运行实例时用它最近活动的那个会话', String(byRunner))

  /* ② 没有实例才看列表；列表取最近活动 */
  const byList = pickProjectSession({
    cwd: A,
    runners: [run({ runId: 'r9', cwd: B, file: 'b.jsonl', at: 30 })],
    sessions: [
      sess({ id: 's1', path: 'a-old.jsonl', cwd: A, at: 10 }),
      sess({ id: 's2', path: 'a-new.jsonl', cwd: A, at: 50 })
    ]
  })
  ok(byList === 'a-new.jsonl', '没有实例时从会话列表里取最近活动的那个', String(byList))

  /*
   * ③ 没给 projectId 时**不能**把挂了 projectId 的会话排除掉。
   * `listSessions` 会给 cwd 命中项目的会话挂 projectId（decorateSessions），
   * 早期写法要求 `!x.projectId`，表现就是“明明有会话却新建一个空的”。
   */
  const decorated = pickProjectSession({
    cwd: A,
    runners: [],
    sessions: [sess({ id: 's1', path: 'a.jsonl', cwd: A, at: 10, projectId: 'p-alpha' })]
  })
  ok(decorated === 'a.jsonl', '没给 projectId 时按 cwd 匹配，不排除已归属项目的会话', String(decorated))

  /* ④ 给了 projectId 就必须严格按归属匹配（同一 cwd 下两个项目归属不能混） */
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

  /* ⑤ 什么都没有 = 该项目还没有会话：返回 undefined，调用方去新建 */
  const none = pickProjectSession({ cwd: A, runners: [], sessions: [sess({ id: 's1', path: 'b.jsonl', cwd: B, at: 1 })] })
  ok(none === undefined, '该项目没有任何会话时返回 undefined（调用方新建）', String(none))

  /* ⑥ 实例存在但没有会话文件（还没落盘）：不能拿它当目标，退回列表 */
  const noFile = pickProjectSession({
    cwd: A,
    runners: [run({ runId: 'r1', cwd: A, file: undefined, at: 30 })],
    sessions: [sess({ id: 's1', path: 'a.jsonl', cwd: A, at: 5 })]
  })
  ok(noFile === 'a.jsonl', '实例还没有会话文件时退回会话列表', String(noFile))
}
