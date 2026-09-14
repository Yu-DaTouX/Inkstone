/**
 * 桌面端专属设置（窗口尺寸、主题、语言、cwd、栏宽/分区布局）。
 *
 * 刻意**不写 pi 的 settings.json** —— 那是 TUI 和扩展的领地，
 * 桌面端改它会污染用户的 pi 配置。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import {
  RAIL_MAX,
  RAIL_MIN,
  PANEL_MAX,
  PANEL_MIN,
  clampPanelWidth,
  clampStreamWidth,
  TOOL_SECTIONS,
  normalizeToolHidden,
  normalizeToolOrder,
  SOUND_VOLUME_MAX,
  SOUND_VOLUME_MIN,
  type AppSettings,
  type ProjectGroup,
  type ProjectRecord,
  type SoundSettings,
  type UserProfile
} from '../shared/ipc'
import { YAN_DIR } from './paths'
import { clampScale } from './zoom-math'

// 数据目录（YAN_DATA_DIR 可覆盖，测试用隔离目录）
const DIR = YAN_DIR
const FILE = join(DIR, 'desktop.json')

/**
 * 默认界面语言**跟随系统**（用户要求）。
 *
 * 优先用 Electron 的 `app.getLocale()` —— 它是系统**界面**语言；
 * 拿不到（还没 ready / 非 Electron）再退到 ICU（`Intl...locale`），
 * 最后才是中文。
 *
 * ⚠️ 只在 desktop.json **没有合法 lang** 时用；用户手动选过就听用户的。
 * 注意 `app` 要 ready 后才准，所以这个函数只能懒调（不能在模块顶层跑）。
 */
const LANGS = ['zh-CN', 'en-US'] as const
function detectLang(): (typeof LANGS)[number] {
  try {
    const l = (app.getLocale?.() || '').toLowerCase()
    if (l) return l.startsWith('zh') ? 'zh-CN' : 'en-US'
  } catch {
    /* 还没 ready */
  }
  try {
    const l = (Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase()
    return l.startsWith('zh') ? 'zh-CN' : 'en-US'
  } catch {
    return 'zh-CN'
  }
}

const DEFAULTS: AppSettings = {
  cwd: homedir(),
  theme: 'dark',
  // 占位；真正生效的是 getSettings 里的 detectLang()（见那里）
  lang: 'zh-CN',
  recentCwds: [],
  projectNames: {},
  projects: [],
  projectGroups: [],
  providerBudgets: {},
  rightPanelOpen: true,
  alwaysOnTop: false,
  // 0 = 自动（按屏幕缩放算，见 main/zoom.ts）
  uiScale: 0,
  // 空名字 → 界面回落到系统用户名（见 defaultProfile）
  profile: defaultProfile(),
  // 0 = 用设计默认宽度（见 AppSettings 的注释）
  railWidth: 0,
  panelWidth: 0,
  // 0 = 用设计默认高度（55% 右栏，见 AppSettings 的注释）
  browserHeight: 0,
  // 空 = 用设计默认顺序
  toolOrder: [],
  toolHidden: [],
  toolHeights: {},
  /*
   * 运行中的工具调用是否**自动展开**详情。
   *
   * 默认 false（N03）：工具调用只留一行，开始 / 增量输出 / 结束都不自动展开。
   * 这是一个**显式偏好** —— 只有用户在设置里主动打开才会自动展开，
   * 具体见 AppSettings.toolDetail 的注释与下面的迁移规则。
   */
  toolDetail: false,
  // 0 = 用设计默认宽度（见 AppSettings 的注释）
  streamWidth: 0,
  // 提问优先（自主模式默认关）
  autonomous: false,
  /*
   * 发送键默认 auto —— 保持用户已有的习惯：短输入框 Enter 发送，
   * 长文模式里 Enter 换行。**不改变默认行为**，只是把它变成可配、
   * 可见的（见 AppSettings.sendKey 的注释）。
   */
  sendKey: 'auto',
  /* 回复详细程度：默认 standard（与改动前行为一致） */
  responseDetail: 'standard',
  /* 密度：默认 standard（与改动前观感一致） */
  density: 'standard',
  // 声音提示默认关（见 SoundSettings 注释）
  sound: defaultSound()
}

/** 声音提示的默认值（总开关关、音量 0.4、三类事件都开） */
function defaultSound(): SoundSettings {
  return {
    enabled: false,
    volume: 0.4,
    notifications: true,
    events: { done: true, question: true, error: true }
  }
}

/**
 * 夹一份干净的声音设置。
 *
 * 设置文件可以被手改，不能信：音量可能写成 -3 / NaN，events 可能是 null。
 * 未知事件键直接丢掉（版本升级后旧键不该一直占位）。
 */
function sanitizeSound(v: unknown): SoundSettings {
  const d = defaultSound()
  if (!v || typeof v !== 'object') return d
  const o = v as Partial<SoundSettings> & Record<string, unknown>
  const rawVol = typeof o.volume === 'number' ? o.volume : Number(o.volume)
  const volume = Number.isFinite(rawVol)
    ? Math.min(SOUND_VOLUME_MAX, Math.max(SOUND_VOLUME_MIN, rawVol))
    : d.volume
  const ev = o.events && typeof o.events === 'object' ? (o.events as Record<string, unknown>) : {}
  const events = {
    done: ev.done === undefined ? d.events.done : ev.done === true,
    question: ev.question === undefined ? d.events.question : ev.question === true,
    error: ev.error === undefined ? d.events.error : ev.error === true
  }
  return { enabled: o.enabled === true, volume, notifications: o.notifications !== false, events }
}

/**
 * 分区高度的范围与校验。
 *
 * 为什么两边都要夹（渲染端拖动时也夹）：拖过头会产生极大/极小的值，
 * 写进设置后再启动就是坏界面 —— 而设置文件用户也能手改。
 * 这个教训来自宽度拖拽（非法值会让 grid 声明整条失效）。
 */
export const HEIGHT_MIN = 80
export const HEIGHT_MAX = 900

function normalizeHeights(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!TOOL_SECTIONS.includes(k as (typeof TOOL_SECTIONS)[number])) continue
    const n = typeof val === 'number' ? val : Number(val)
    if (!Number.isFinite(n)) continue
    out[k] = Math.round(Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, n)))
  }
  return out
}

/**
 * 默认用户档案。
 *
 * 名字默认用**系统用户名**（`os.userInfo().username`）而不是写死「用户」：
 * 首启动就有个真名，用户想改再改。取不到（极小概率）就空串，
 * 界面会用「你」兼底。
 */
function defaultProfile(): UserProfile {
  let name = ''
  try {
    name = userInfo().username ?? ''
  } catch {
    /* 取不到就用空名 */
  }
  return {
    name,
    avatarKind: 'letter',
    avatarValue: '',
    avatarHue: -1,
    signedIn: false
  }
}

/** 夹一个干净的用户档案（设置文件可能被手改，不能信） */
function sanitizeProfile(v: unknown): UserProfile {
  const d = defaultProfile()
  if (!v || typeof v !== 'object') return d
  const o = v as Partial<UserProfile> & Record<string, unknown>
  const kind = o.avatarKind === 'icon' ? 'icon' : 'letter'
  const hueRaw = typeof o.avatarHue === 'number' ? o.avatarHue : -1
  return {
    // 名字限长 32：左栏那一行放不下更长的，而且设置文件不该被写进巨串
    name: typeof o.name === 'string' ? o.name.slice(0, 32) : d.name,
    avatarKind: kind,
    avatarValue: typeof o.avatarValue === 'string' ? o.avatarValue.slice(0, 32) : '',
    avatarHue: Number.isFinite(hueRaw) ? Math.min(360, Math.max(-1, hueRaw)) : -1,
    // 恒为 false（登录未接入）—— 即使设置文件里被写成 true 也不信
    signedIn: false
  }
}

function projectId(cwd: string): string {
  // 路径变更前后 id 独立保存；这里仅用于旧设置的确定性迁移。
  return `project-${Buffer.from(cwd.toLowerCase()).toString('base64url').slice(0, 36)}`
}

function sanitizeProjects(v: unknown, names: Record<string, string>, recent: string[], cwd: string): ProjectRecord[] {
  const now = Date.now()
  const raw = Array.isArray(v) ? v : []
  const out: ProjectRecord[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Partial<ProjectRecord>
    if (typeof o.id !== 'string' || !o.id || typeof o.cwd !== 'string' || !o.cwd || seen.has(o.id)) continue
    seen.add(o.id)
    out.push({ id: o.id.slice(0, 80), cwd: o.cwd, name: typeof o.name === 'string' ? o.name.trim().slice(0, 64) : '', groupId: typeof o.groupId === 'string' ? o.groupId.slice(0, 80) : undefined, archived: o.archived === true, createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : now, updatedAt: Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : now })
  }
  for (const path of new Set([...Object.keys(names), ...recent, cwd])) {
    if (!path || out.some((p) => p.cwd === path)) continue
    out.push({ id: projectId(path), cwd: path, name: names[path]?.trim().slice(0, 64) ?? '', archived: false, createdAt: now, updatedAt: now })
  }
  return out
}

function sanitizeProjectGroups(v: unknown): ProjectGroup[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  return v.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const o = item as Partial<ProjectGroup>
    if (typeof o.id !== 'string' || !o.id || seen.has(o.id) || typeof o.name !== 'string' || !o.name.trim()) return []
    seen.add(o.id)
    return [{ id: o.id.slice(0, 80), name: o.name.trim().slice(0, 48), createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : Date.now() }]
  })
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
    // 语言：文件里没有合法值就跟随系统（用户手动选过就听用户的）
    if (!LANGS.includes(cached.lang as (typeof LANGS)[number])) cached.lang = detectLang()
    if (!Array.isArray(cached.recentCwds)) cached.recentCwds = []
    if (!cached.projectNames || typeof cached.projectNames !== 'object' || Array.isArray(cached.projectNames)) cached.projectNames = {}
    cached.projectGroups = sanitizeProjectGroups(cached.projectGroups)
    cached.projects = sanitizeProjects(cached.projects, cached.projectNames, cached.recentCwds, cached.cwd)
    if (!cached.providerBudgets || typeof cached.providerBudgets !== 'object' || Array.isArray(cached.providerBudgets)) cached.providerBudgets = {}
    if (typeof cached.rightPanelOpen !== 'boolean') cached.rightPanelOpen = true
    // 置顶：非布尔值一律当 false（不能因为读到个脏值就把窗口钉在最上层）
    cached.alwaysOnTop = cached.alwaysOnTop === true
    // 缩放：夹到合法区间，读不到就自动（不能因为脏值把界面撑成 3 倍）
    cached.uiScale = clampScale(cached.uiScale)
    cached.profile = sanitizeProfile(cached.profile)
    cached.railWidth = clampPanelWidth(cached.railWidth, RAIL_MIN, RAIL_MAX)
    cached.panelWidth = clampPanelWidth(cached.panelWidth, PANEL_MIN, PANEL_MAX)
    cached.browserHeight = clampPanelWidth(cached.browserHeight, HEIGHT_MIN, HEIGHT_MAX)
    // 分区顺序/隐藏集合：未知 id 一律丢掉（版本升级后旧 id 不该一直占位）
    cached.toolOrder = normalizeToolOrder(cached.toolOrder)
    cached.toolHidden = normalizeToolHidden(cached.toolHidden)
    cached.toolHeights = normalizeHeights(cached.toolHeights)
    /*
     * toolDetail 的迁移历史（见 AppSettings.toolDetail 的注释）：
     *   v1  「已结束的能不能点开」—— 旧配置里的 false 只是默认值；
     *   v2  改成「运行中是否自动展开」，迁移时把老配置一律升为 true；
     *   v3（N03）默认值再改为 **收起**，且只有显式开关（toolDetailExplicit）
     *       才算用户偏好。v2 迁移强制写入的 true 是默认值、不是偏好，
     *       在 v3 里同样被重置 —— 否则升级后又会「自动展开干扰」。
     *   规则是幂等的：没有显式偏好的配置每次都归到 false。
     */
    if (cached.toolDetailExplicit !== true) {
      cached.toolDetail = false
    } else {
      // 显式偏好：非 true 一律当关（含缺失与脏值）
      cached.toolDetail = cached.toolDetail === true
    }
    cached.streamWidth = clampStreamWidth(cached.streamWidth)
    cached.autonomous = cached.autonomous === true
    // 发送键：只认三个已知值，脏值回落到 auto（默认行为）
    cached.sendKey =
      cached.sendKey === 'enter' || cached.sendKey === 'ctrlEnter' ? cached.sendKey : 'auto'
    // 回复详细程度：只认三个已知值，脏值 / 缺失回落到 standard
    cached.responseDetail =
      cached.responseDetail === 'brief' || cached.responseDetail === 'detailed'
        ? cached.responseDetail
        : 'standard'
    // 密度：只认三个已知值，脏值 / 缺失回落到 standard
    cached.density =
      cached.density === 'compact' || cached.density === 'comfortable'
        ? cached.density
        : 'standard'
    cached.sound = sanitizeSound(cached.sound)
  } catch {
    cached = { ...DEFAULTS }
    cached.lang = detectLang()
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
  if (patch.projectNames) {
    next.projectNames = Object.fromEntries(Object.entries(patch.projectNames)
      .filter(([path, name]) => path && typeof name === 'string' && name.trim())
      .map(([path, name]) => [path, name.trim().slice(0, 64)]))
  }
  if ('projects' in patch) next.projects = sanitizeProjects(patch.projects, next.projectNames, next.recentCwds, next.cwd)
  else next.projects = sanitizeProjects(next.projects, next.projectNames, next.recentCwds, next.cwd)
  if ('projectGroups' in patch) next.projectGroups = sanitizeProjectGroups(patch.projectGroups)
  // 档案是合并写入（只改名字不能把头像清空），且一律过一遍校验
  next.profile = sanitizeProfile({ ...next.profile, ...(patch.profile ?? {}) })
  // 宽度同样夹一下（渲染端传 0 = 恢复默认）
  if ('railWidth' in patch) next.railWidth = clampPanelWidth(next.railWidth, RAIL_MIN, RAIL_MAX)
  if ('panelWidth' in patch) next.panelWidth = clampPanelWidth(next.panelWidth, PANEL_MIN, PANEL_MAX)
  if ('browserHeight' in patch) next.browserHeight = clampPanelWidth(next.browserHeight, HEIGHT_MIN, HEIGHT_MAX)
  if ('streamWidth' in patch) next.streamWidth = clampStreamWidth(next.streamWidth)
  if ('sound' in patch) {
    // 合并写入的基准取**磁盘上的旧值** cur.sound（已过 sanitize），
    // 不能用 next.sound —— 它是 patch 的原始值，partial 时 events 会是 undefined
    const base = cur.sound
    const incoming = (patch.sound ?? {}) as Partial<SoundSettings>
    next.sound = sanitizeSound({
      ...base,
      ...incoming,
      events: { ...base.events, ...(incoming.events ?? {}) }
    })
  }
  if (next.cwd && next.cwd !== cur.cwd) {
    next.recentCwds = [next.cwd, ...next.recentCwds.filter((p) => p !== next.cwd)].slice(0, 8)
  }
  // 旧的路径 → 名称映射同步到实体，之后 UI 可以只依赖 projects。
  next.projects = sanitizeProjects(next.projects, next.projectNames, next.recentCwds, next.cwd).map((project) => ({
    ...project,
    name: next.projectNames[project.cwd] ?? project.name,
    groupId: next.projectGroups.some((g) => g.id === project.groupId) ? project.groupId : undefined
  }))

  cached = next
  try {
    await mkdir(DIR, { recursive: true })
    await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    console.error('[settings] 写入失败：', e)
  }
  return next
}
