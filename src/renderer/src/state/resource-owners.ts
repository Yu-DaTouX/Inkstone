/**
 * 工作区资源（终端、文件预览）属于哪条会话。
 *
 * 资源本身仍由各自的 owner 管理（终端在主进程、文件预览在 store）；这里只记「挂在哪条会话旁边」，
 * 键是工作区布局用的会话键（`workbenchSessionKey`）。分屏时每块磁贴只显示自己会话的资源；
 * 单会话时切到别的会话，上一条会话的终端也不再跟过来。
 *
 * 没登记过的资源（旧版本留下的、或由宿主直接开出来的）第一次被看到时归给当时正在看的会话。
 */
const STORAGE_KEY = 'inkstone.workspace.owners.v1'
const LIMIT = 400

let cache: Record<string, string> | null = null

function load(): Record<string, string> {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
  } catch {
    cache = {}
  }
  return cache
}

function save(map: Record<string, string>): void {
  const entries = Object.entries(map)
  /* 只留最近的一批：关掉的终端、看过的文件不会一直堆着 */
  const kept = entries.length > LIMIT ? Object.fromEntries(entries.slice(entries.length - LIMIT)) : map
  cache = kept
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)) } catch { /* 偏好写失败不影响使用资源 */ }
}

/** 资源 id 用工作区窗格 id 的形态：`terminal:<id>`、`file:<key>` */
export function resourceOwner(resource: string): string | undefined {
  return load()[resource]
}

/** 还没有主人的资源归给 `owner`；已有主人的不动。返回实际的主人 */
export function claimResource(resource: string, owner: string): string {
  const map = load()
  const current = map[resource]
  if (current) return current
  save({ ...map, [resource]: owner })
  return owner
}

/** 资源关掉了：忘掉它的主人 */
export function releaseResource(resource: string): void {
  const map = load()
  if (!(resource in map)) return
  const next = { ...map }
  delete next[resource]
  save(next)
}
