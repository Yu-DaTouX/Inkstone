/**
 * 文件资源的稳定身份（实施-11 H-4）。
 *
 * 为什么不能只用文件名、也不能只用绝对路径：
 *   · 只用文件名：两个工作树里的 `index.ts` 会撞成同一个标签；
 *   · 只用 canonicalPath：同一个物理文件在不同项目上下文里无法区分；
 *   · 不规范化路径：`a/../b.ts` 与 `b.ts`、软链接与实际路径会造出第二个身份。
 *
 * 所以身份是三元组：`projectId + workspaceRoot + canonicalPath`。
 * `canonicalPath` 必须是主进程 realpath 之后的 `abs`（不是链接里写的原路径），
 * 这样标签的合并/去重与「缺失后重试」用的是同一个键。
 *
 * 纯函数模块：主进程、渲染端与单测共用，不读盘、不碰 DOM。
 */

export interface FileResourceIdentity {
  /** 项目 id（不在任何项目里就是 null） */
  projectId?: string | null
  /** 工作树根（会话 cwd 的 realpath 或项目根） */
  workspaceRoot?: string | null
  /** 规范化绝对路径（realpath） */
  canonicalPath: string
}

const SEP = '|'
const EMPTY = '-'

/**
 * 段编码：`|` 与非法字符都进编码，保证 `split('|')` 一定能还原。
 * 不用裸路径是因为 Windows 路径合法字符里虽然没有 `|`，但 POSIX 允许 ——
 * 而身份一旦被拆错，两个不同文件就会互相顶掉标签。
 */
function encodePart(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  return v ? encodeURIComponent(v) : EMPTY
}

function decodePart(value: string): string | null {
  if (!value || value === EMPTY) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 由三元组构造标签身份键。空的项目 / 工作树用 `-` 占位，不丢位置。 */
export function fileResourceKey(identity: FileResourceIdentity): string {
  return [
    encodePart(identity.projectId),
    encodePart(identity.workspaceRoot),
    encodePart(identity.canonicalPath)
  ].join(SEP)
}

/** 解析身份键；段数不对或路径为空就返回 null（脏输入不造身份）。 */
export function parseFileResourceKey(key: string): FileResourceIdentity | null {
  const parts = String(key ?? '').split(SEP)
  if (parts.length !== 3) return null
  const canonicalPath = decodePart(parts[2])
  if (!canonicalPath) return null
  return { projectId: decodePart(parts[0]), workspaceRoot: decodePart(parts[1]), canonicalPath }
}

/** 标签显示名：取路径最后一段，Windows / POSIX 分隔符与尾斜杠都认。 */
export function fileResourceLabel(canonicalPath: string): string {
  const norm = String(canonicalPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

/**
 * 把**文档内**的相对链接解析成绝对路径（H-4 出口 3）。
 *
 * 为什么不能用会话 cwd：在文档里写 `[返回](../README.md)`，
 * 基准是**这篇文档所在的目录**，不是会话工作目录。
 *
 * 纯字符串计算（不碰磁盘）：只归一 ` / `、`.` 与 `..`，保留盘符；
 * `..` 到根就不再上溯（不会造出 `..` 前缀）。返回统一用 `/`，
 * 主进程的 `isAbsolute` 在 Windows 上同样认这种写法。
 */
export function resolveRelativePath(baseDir: string, rel: string): string {
  const base = String(baseDir ?? '').replace(/[\\/]+$/, '')
  const segs = base.replace(/\\/g, '/').split('/')
  for (const raw of String(rel ?? '').replace(/\\/g, '/').split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') {
      if (segs.length > 1) segs.pop()
      continue
    }
    segs.push(raw)
  }
  return segs.join('/')
}

/**
 * 两个路径是不是同一个文件（仅用于界面层的同类判断，如「要不要提示重新加载」）。
 *
 * 真正的身份合并走 `canonicalPath` 精确匹配：它已经是 realpath 的结果，
 * 软链接与 `..` 都已归一，不需要在这里做跨平台大小写猜测
 * （渲染端也拿不到可靠的 `process.platform`）。
 */
export function sameResourcePath(a: string, b: string): boolean {
  return String(a ?? '').replace(/\\/g, '/') === String(b ?? '').replace(/\\/g, '/')
}
