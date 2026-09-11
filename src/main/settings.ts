/**
 * 桌面端专属设置（窗口尺寸、主题、语言、cwd、记忆排序）。
 *
 * 刻意**不写 pi 的 settings.json** —— 那是 TUI 和扩展的领地，
 * 桌面端改它会污染用户的 pi 配置。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '../shared/ipc'
import { YAN_DIR } from './memory'

// 与记忆共用目录（YAN_DATA_DIR 可覆盖，测试用隔离目录）
const DIR = YAN_DIR
const FILE = join(DIR, 'desktop.json')

const DEFAULTS: AppSettings = {
  cwd: homedir(),
  theme: 'dark',
  lang: 'zh-CN',
  memoryOrder: ['soul', 'about', 'impressions', 'people', 'projects', 'status'],
  recentCwds: [],
  rightPanelOpen: true,
  alwaysOnTop: false
}

let cached: AppSettings | null = null

/** 清掉内存缓存（下次 getSettings 重新读盘） */
function invalidate(): void {
  cached = null
}

export async function getSettings(): Promise<AppSettings> {
  if (cached) return cached
  try {
    const raw = await readFile(FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cached = { ...DEFAULTS, ...parsed }
    if (!Array.isArray(cached.memoryOrder) || cached.memoryOrder.length === 0) {
      cached.memoryOrder = [...DEFAULTS.memoryOrder]
    }
    if (!Array.isArray(cached.recentCwds)) cached.recentCwds = []
    if (typeof cached.rightPanelOpen !== 'boolean') cached.rightPanelOpen = true
    // 置顶：非布尔值一律当 false（不能因为读到个脏值就把窗口钉在最上层）
    cached.alwaysOnTop = cached.alwaysOnTop === true
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  /*
   * 先清掉内存缓存，让下面 getSettings 重新读盘。
   *
   * ⚠️ 为什么不能直接用 `cached`：写回的是**整个对象**。
   *   `cached` 是进程启动时（或上次写时）的快照，只要有两个写入方，
   *   就会互相覆盖 —— 本会话真踩到了：
   *   一个实例内存里是 `alwaysOnTop: true`，它每次因为主题/语言变化调
   *   `patchSettings({theme})` 时，会把那个 true 又写回去，
   *   把另一个实例改成 false 的结果抹掉。
   *   重读一次的代价是一次小文件读，而设置写入是低频操作。
   */
  invalidate()
  const cur = await getSettings()
  const next: AppSettings = { ...cur, ...patch }

  if (patch.recentCwds) {
    // 去重、保留最近 8 个
    next.recentCwds = [...new Set(patch.recentCwds)].slice(0, 8)
  }
  if (next.cwd && next.cwd !== cur.cwd) {
    next.recentCwds = [next.cwd, ...next.recentCwds.filter((p) => p !== next.cwd)].slice(0, 8)
  }

  cached = next
  try {
    await mkdir(DIR, { recursive: true })
    await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    console.error('[settings] 写入失败：', e)
  }
  return next
}
