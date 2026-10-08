/**
 * 「这个会话关联过哪些文件」的本地登记（localStorage）。
 *
 * 文件引用**不复制**文件本身（大文件不该被我们抄一份），所以来源菜单需要
 * 一个地方记住关联关系。三类来源里只有它是纯本地登记：图片在受控目录里、
 * 网页只有 URL 记录。
 *
 * ── 为什么单独抽成一个模块 ──
 * 读写必须在**同一处**定义，并且都按会话隔离。踩过两次，方向相反：
 *   · 写入时只保留当前会话的记录、把别的会话整段覆盖掉 —— 切回去登记就没了；
 *   · 读侧（来源菜单、工作台首页）没有按 sessionId 过滤 —— 把别的会话的
 *     文件列进这个会话的来源里。
 * 所以类型、键名、增删改查都放这里，调用方只管传 sessionId。
 */
export const SOURCE_FILES_KEY = 'yan.source-files.v1'
/** 最多留多少条登记（够用，且不会把 localStorage 撑爆）。 */
const MAX_RECORDS = 200

export interface SourceFileRecord {
  path: string
  name: string
  addedAt: number
  sessionId: string
}

function isRecord(value: unknown): value is SourceFileRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SourceFileRecord>
  return (
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0
  )
}

function write(records: SourceFileRecord[]): void {
  try {
    localStorage.setItem(SOURCE_FILES_KEY, JSON.stringify(records.slice(-MAX_RECORDS)))
  } catch {
    /* 存不下不影响本次会话里看到的东西 */
  }
}

/** 读出全部登记（容错：坏数据当空）。 */
export function readSourceFiles(): SourceFileRecord[] {
  try {
    const raw = localStorage.getItem(SOURCE_FILES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

/** 某个会话的文件登记。**必须**按会话过滤：主进程复核只认会话内的路径。 */
export function listSourceFiles(sessionId: string): SourceFileRecord[] {
  if (!sessionId) return []
  return readSourceFiles().filter((record) => record.sessionId === sessionId)
}

/** 给某个会话追加登记：保留其它会话的记录，按时间截断。 */
export function addSourceFiles(sessionId: string, paths: string[]): void {
  if (!sessionId || !paths.length) return
  const all = readSourceFiles()
  const mine = all.filter((record) => record.sessionId === sessionId)
  const others = all.filter((record) => record.sessionId !== sessionId)
  for (const path of paths) {
    if (!path || mine.some((record) => record.path === path)) continue
    mine.push({ path, name: path.split(/[\\/]/).pop() ?? path, addedAt: Date.now(), sessionId })
  }
  write([...others, ...mine].sort((a, b) => a.addedAt - b.addedAt))
}

/** 删掉**这个会话**对某个文件的登记（原文件是用户的，这里永不碰）。 */
export function removeSourceFile(sessionId: string, path: string): void {
  if (!sessionId) return
  write(readSourceFiles().filter((record) => !(record.sessionId === sessionId && record.path === path)))
}
