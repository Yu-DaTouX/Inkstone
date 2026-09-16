import type { RunnerStatus, SessionSummary } from '../../../shared/ipc'

/**
 * 切项目时选「该项目最近访问的会话」（N05）。
 *
 * 为什么要单独一个纯函数（而不是写在 `Rail.switchProject` 里）：
 *   · 它是切项目的**唯一决策点**：选错了就会落到 `newSession`，而草稿是按
 *     `sessionId` 存在运行时缓存里的 —— 新建会话 = 新 id = 用户的草稿回不来；
 *   · 需要在单测里把各种组合（只有运行实例 / 只有会话列表 / 两者都有 /
 *     projectId 匹配与否 / Windows 分隔符与大小写）一次性钉死。
 *
 * 判定顺序：
 *   ① **运行实例**（`runners`）优先 —— 它带着 `sessionFile`，是「这个项目
 *      刚才在看哪个会话」最直接的证据；而且刚建、还没写进 JSONL 的会话
 *      **不会**出现在 `sessions` 列表里（`listSessions` 解析不出 head 就跳过）；
 *   ② 其次才是会话列表：给了 `projectId` 就按归属匹配，没给就按 cwd 匹配（取
 *      最近活动的那条）。
 *      ⚠️ 没给 `projectId` 时**不能**要求 `!x.projectId`：`listSessions` 会给
 *      cwd 命中项目的会话挂上 `projectId`（`decorateSessions`），那样会把该项目的
 *      会话全部排除掉，表现就是“明明有会话却返回 undefined 去新建”。
 */
export function pickProjectSession(input: {
  cwd: string
  projectId?: string
  runners: Pick<RunnerStatus, 'cwd' | 'projectId' | 'sessionFile' | 'lastActiveAt'>[]
  sessions: Pick<SessionSummary, 'path' | 'cwd' | 'projectId' | 'scope' | 'lastActivityAt' | 'updatedAt'>[]
}): string | undefined {
  const { cwd, projectId, runners, sessions } = input

  const runner = runners
    .filter(
      (r) =>
        !!r.sessionFile &&
        sameCwd(r.cwd, cwd) &&
        (!projectId || r.projectId === projectId)
    )
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
  if (runner?.sessionFile) return runner.sessionFile

  const recent = sessions
    .filter((x) => (projectId ? x.projectId === projectId : sameCwd(x.cwd, cwd)))
    .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))[0]
  return recent?.path
}

/**
 * 同一个工作目录。
 *
 * 不能直接比字符串：Windows 上同一个目录可能写成 `C:\a\b` 或 `C:/a/b`
 * （pi 回传的路径与我们拼的路径经常混用），大小写也不敏感。
 */
export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  const norm = (p: string | undefined): string =>
    (p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}
