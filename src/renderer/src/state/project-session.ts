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
 *   ② 其次才是会话列表：给了 `projectId` 就按归属匹配，没给就按 cwd 匹配，
 *      取排序第一的（见下）。
 *      ⚠️ 没给 `projectId` 时**不能**要求 `!x.projectId`：`listSessions` 会给
 *      cwd 命中项目的会话挂上 `projectId`（`decorateSessions`），那样会把该项目的
 *      会话全部排除掉，表现就是“明明有会话却返回 undefined 去新建”。
 *
 * ── 排序键：先「打开过」再「活跃过」（实施-09 S3）──
 * `lastOpenedAt` 是**用户在砚里真的打开过**的时间（宿主记的）；`lastActivityAt`
 * 是会话文件里最后一条 message 的时间。两者不等价：后台跑过消息的会话（自动继续、
 * 子代理写回）活动更新，但用户上次看的是另一个 —— 恢复哪一个应该听用户的。
 * 两个都没有时回落到 `updatedAt`（旧数据 / 刚迁移的会话）。
 *
 * 口径（[实施-09 §4](../plan/实施-09-交付与验收收尾.md)）要求**不新增第二份真源**：
 * 会话文件始终是唯一真源，排序全部在扫描结果上做，**不存 project → sessionId 映射**。
 * `lastOpenedAt` 丢了 / 被清了也不会让人认不出会话——它只影响“先选哪个”的顺序。
 */
export function pickProjectSession(input: {
  cwd: string
  projectId?: string
  runners: Pick<RunnerStatus, 'cwd' | 'projectId' | 'sessionFile' | 'lastActiveAt'>[]
  sessions: Pick<
    SessionSummary,
    'path' | 'cwd' | 'projectId' | 'scope' | 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'
  >[]
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
    .sort(compareRecency)[0]
  return recent?.path
}

/**
 * 排序：「打开过」的整个类别排在「只在后台活跃过」之前（实施-09 S3）。
 *
 * 为什么不直接比两个时间戳的大小：它们的语义不同 —— `lastOpenedAt` 是
 * 「用户上次看它」，`lastActivityAt` 是「它自己最近动过」（后台续行、子代理写回、
 * 另一个窗口发消息都会刷新它）。直接混比会让「用户三周前看的那个会话」输给
 * 「一小时前后台跑过一句的会话」—— 那不是「项目最后一个会话」。同类内再比时间。
 *
 * 两个类别都是空的（旧数据 / 刚从别处拷来的会话）→ 回落到 `updatedAt`，
 * 而**不依赖文件 mtime**（口径里写死的：复制、恢复备份、系统时钟都会污染 mtime）。
 */
function compareRecency(
  a: Pick<SessionSummary, 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'>,
  b: Pick<SessionSummary, 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'>
): number {
  const aOpened = a.lastOpenedAt ?? 0
  const bOpened = b.lastOpenedAt ?? 0
  if (aOpened > 0 !== bOpened > 0) return aOpened > 0 ? -1 : 1
  if (aOpened > 0 && bOpened > 0) return bOpened - aOpened
  return (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt)
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
