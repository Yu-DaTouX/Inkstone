/**
 * 桌面端专属设置（窗口尺寸、主题、语言、cwd、栏宽/分区布局）。
 *
 * 刻意**不写 pi 的 settings.json** —— 那是 TUI 和扩展的领地，
 * 桌面端改它会污染用户的 pi 配置。
 */
import { readFile, mkdir, copyFile, open, rename, unlink } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { cleanModelChoice, cleanModelFavorites, cleanProviderOrder } from '../shared/model-selection'
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
import { sanitizeActivityModelConfig } from '../shared/activity-model'
import { clampScale } from './zoom-math'
import { projectIdForCwd } from './project-id'
import { DEFAULT_PERMISSION_MODE, isLegacyPermissionMode, normalizePermissionMode } from '../shared/approval'
import { DEFAULT_WORK_MODE, migrateLegacyAutonomous, normalizeWorkMode, normalizeWorkModeShortcut } from '../shared/work-mode'
import { DEFAULT_QUESTION_FREQUENCY, normalizeQuestionFrequency } from '../shared/question-frequency'
import { migrateToolLayout, normalizeToolLayout } from '../shared/tool-layout'
import { AUTO_COMPACT_STEPS, CONTEXT_TRIM_STEPS, DEFAULT_AUTO_COMPACT_TOKENS, DEFAULT_CONTEXT_TRIM_TOKENS, pickTokenStep } from '../shared/context-limits'
import { isWorkspaceMode } from '../shared/workspace-mode'
import { voiceModelSpec } from '../shared/voice-input'
import { normalizeAutoArchiveDays } from '../shared/session-archive'
import { FONT_BODY_DEFAULT, FONT_BODY_MAX, FONT_BODY_MIN, FONT_UI_DEFAULT, FONT_UI_MAX, FONT_UI_MIN, sanitizeFontCodePreset, sanitizeFontName, sanitizeFontSize, sanitizeFontUiPreset } from '../shared/appearance'
import {
  sanitizeContextPolicyByModel,
  sanitizeContextPolicyOverrides
} from '../shared/context-policy'

// 数据目录（YAN_DATA_DIR 可覆盖，测试用隔离目录）
const DIR = YAN_DIR
const FILE = join(DIR, 'desktop.json')

/** 采样温度表：只收 0–2 的有限数、保留两位小数；空表落成「没设过」，不写进文件。 */
function cleanTemperatureByModel(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) out[key] = Math.round(value * 100) / 100
  }
  return Object.keys(out).length ? out : undefined
}

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
  projectOrder: [],
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
  /*
   * 旧的全自主开关（**实施-05 起不再是界面开关**）。
   * 保留字段：旧版本读过它、用户磁盘上也有值；迁移与兜底还要用。
   */
  autonomous: false,
  /* 新会话的默认工作模式；旧 `autonomous` 只是迁移输入（见下方清洗） */
  defaultWorkMode: DEFAULT_WORK_MODE,
  /* 歧义澄清提问频率：三档全局偏好，默认适中（见 shared/question-frequency.ts） */
  questionFrequency: DEFAULT_QUESTION_FREQUENCY,
  capabilityStrategy: 'auto-connect',
  codemodeEnabled: true,
  guardOutsideWrites: false,
  permissionMode: DEFAULT_PERMISSION_MODE,
  guardAllowRoots: [],
  checkpointsEnabled: true,
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

/**
 * 项目知识（实施-03）的用户开关：与 `sanitizeContextDeep` 同一条约定 ——
 * 只认字面 `true`，其余（含 `false` / 脏值 / 缺失）一律 `undefined`。
 *
 * 「没改过」与「明确关掉」在磁盘上因此长得不一样：后者会落 `{enabled:false}`，
 * 以后调整默认值时不会把改过的人一起改掉。
 */
function sanitizeProjectKnowledge(v: unknown): { enabled: boolean } | undefined {
  if (!v || typeof v !== 'object') return undefined
  const enabled = (v as { enabled?: unknown }).enabled
  if (enabled === true) return { enabled: true }
  if (enabled === false) return { enabled: false }
  return undefined
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
/**
 * Deep Context（N21-8）的清洗。
 *
 * 只认字面 `true`；其余（`false` / 脏值 / 缺失）一律 `undefined` ——
 * 「默认关」不需要在文件里留一个 `{enabled:false}`：那样「没改过」与
 * 「明确关掉」在磁盘上长得一模一样，以后改默认值时就分不清了。
 */
function sanitizeContextDeep(v: unknown): { enabled: boolean } | undefined {
  if (!v || typeof v !== 'object') return undefined
  return (v as { enabled?: unknown }).enabled === true ? { enabled: true } : undefined
}

/**
 * `episode-fold` 的用户开关（P2-7）：只认字面 `false`。
 *
 * 与 `sanitizeContextDeep` **方向相反** —— 它在默认接管集里，所以是「默认开、
 * 只有明确关掉才落盘」。两边共同遵守的约定是：磁盘上没有这个键 = 用户没改过，
 * 以后调默认值时不会把改过的人一起改掉（与 `railWidth: 0` / `contextPolicy` 同一条）。
 */
function sanitizeContextFold(v: unknown): { enabled: boolean } | undefined {
  if (!v || typeof v !== 'object') return undefined
  return (v as { enabled?: unknown }).enabled === false ? { enabled: false } : undefined
}

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

function projectId(cwd: string, isTaken?: (id: string) => boolean): string {
  /* 派生规则与碰撞退路在 project-id.ts（那里有 D14 的完整说明）。 */
  return projectIdForCwd(cwd, isTaken)
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
  const usedIds = new Set(out.map((p) => p.id))
  for (const path of new Set([...Object.keys(names), ...recent, cwd])) {
    if (!path || out.some((p) => p.cwd === path)) continue
    /*
     * id 不能与**别的 cwd** 共用：同前缀目录会撞旧算法的 36 字符截断，
     * 而按 id 反查项目的入口（文件树 / @ 补全 / 搜索）会因此误判。
     */
    const id = projectId(path, (candidate) => usedIds.has(candidate))
    usedIds.add(id)
    out.push({ id, cwd: path, name: names[path]?.trim().slice(0, 64) ?? '', archived: false, createdAt: now, updatedAt: now })
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

/**
 * 项目顺序（N01）：只留字符串、去重、限制长度。
 *
 * 为什么不在这里跟 `projects` 交叉过滤：`patchSettings` 允许一次调用同时
 * 传 `projects` 与 `projectOrder`（拖拽新建顺序的场景没有，但改名/归档会），
 * 两处清洗顺序不同就会互相打架。未知 id 在渲染端排序时被自然忽略，
 * 交叉过滤放在 `getSettings`（读盘后的静态清洗）里做。
 */
function sanitizeProjectOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string') continue
    const id = item.trim().slice(0, 80)
    if (id) seen.add(id)
    if (seen.size >= 500) break
  }
  return [...seen]
}

let cached: AppSettings | null = null
let cacheGeneration = 0

/**
 * 设置写入的**串行队列**（N01 尾巴，2026-09-19 拓到）。
 *
 * ── 为什么必须有它 ──
 * `patchSettings()` 是「读盘 → 合并 → 写盘」，而它不是原子的：两个并发调用会
 * 各自读到同一份旧内容，后写的那个把前一个的结果**整份盖掉**。
 * 2026-09-19 真踩到：工作树创建后要 `patchSettings({projects:[...已有, 新工作树]})`，
 * 同时另一个调用方（信任查询）在 `getSettings()` 里读了同一份旧文件并缓存 ——
 * 结果界面上项目列表里**新工作树不见了**，而 git 侧工作树明明建成功。
 *
 * 修法是把写入排成一条链：每个 patch 拿到的是**上一个写完之后的**磁盘内容。
 * 读（`getSettings`）不进队列 —— 它不会改文件，且高频调用（界面每次渲染都可能读）
 * 若要排队反而会把写拖慢。
 */
let writeQueue: Promise<unknown> = Promise.resolve()

/** 清掉内存缓存（下次 getSettings 重新读盘） */
function invalidate(): void {
  cacheGeneration++
  cached = null
}

/**
 * 新安装的默认工作文件夹：「文档砚」，而不是整个用户主目录。
 *
 * Agent 的写入范围以工作目录为界（写到目录之外会先确认并可记住），所以默认范围越小越安全；
 * 日常用法（表格、整理文件）本来就没有项目，给一个专用文件夹最合适。
 * 取系统「文档」位置（可能被 OneDrive 重定向）；建不出来才退回主目录。
 */
async function defaultWorkFolder(): Promise<string> {
  let documents = join(homedir(), 'Documents')
  try {
    documents = app.getPath('documents')
  } catch {
    /* 还没 ready 或平台没有这个位置 */
  }
  const dir = join(documents, '砚')
  try {
    await mkdir(dir, { recursive: true })
    return dir
  } catch {
    return homedir()
  }
}

function sanitizeSettings(parsed: Partial<AppSettings>): AppSettings {
  const settings = { ...DEFAULTS, ...parsed } as AppSettings
  /*
   * 工作模式迁移的输入必须是**文件里的原值**，不能用合并后的：
   * DEFAULTS 里有 `defaultWorkMode: 'standard'`，合完之后永远“合法”，
   * 旧用户的 `autonomous: true` 就再也迁不过来了（探针会当场抓住）。
   */
  const fileWorkMode = parsed.defaultWorkMode
  // 语言：文件里没有合法值就跟随系统（用户手动选过就听用户的）
  if (!LANGS.includes(settings.lang as (typeof LANGS)[number])) settings.lang = detectLang()
  if (settings.theme !== 'light' && settings.theme !== 'dark') settings.theme = 'dark'
  if (!Array.isArray(settings.recentCwds)) settings.recentCwds = []
  if (!settings.projectNames || typeof settings.projectNames !== 'object' || Array.isArray(settings.projectNames)) settings.projectNames = {}
  settings.projectGroups = sanitizeProjectGroups(settings.projectGroups)
  settings.projects = sanitizeProjects(settings.projects, settings.projectNames, settings.recentCwds, settings.cwd)
  // 项目顺序：未知 / 已删除的项目 id 丢掉（否则设置文件会越来越长）
  const knownProjects = settings.projects
  settings.projectOrder = sanitizeProjectOrder(settings.projectOrder)
    .filter((id) => knownProjects.some((project) => project.id === id))
  if (!settings.providerBudgets || typeof settings.providerBudgets !== 'object' || Array.isArray(settings.providerBudgets)) settings.providerBudgets = {}
  if (typeof settings.rightPanelOpen !== 'boolean') settings.rightPanelOpen = true
  /*
   * 工作区模式（实施-18 S0）：只认两个合法值；脏值 / 缺失一律归到
   * `undefined`（磁盘上没有这个键），让渲染端能区分「没设置过」并做
   * localStorage 一次性迁移。不写回 DEFAULTS，避免迁移信号被默认值淹没。
   */
  settings.workspaceMode = isWorkspaceMode(settings.workspaceMode) ? settings.workspaceMode : undefined
  // 置顶：非布尔值一律当 false（不能因为读到个脏值就把窗口钉在最上层）
  settings.alwaysOnTop = settings.alwaysOnTop === true
  // 缩放：夹到合法区间，读不到就自动（不能因为脏值把界面撑成 3 倍）
  settings.uiScale = clampScale(settings.uiScale)
  settings.profile = sanitizeProfile(settings.profile)
  settings.railWidth = clampPanelWidth(settings.railWidth, RAIL_MIN, RAIL_MAX)
  settings.panelWidth = clampPanelWidth(settings.panelWidth, PANEL_MIN, PANEL_MAX)
  settings.browserHeight = clampPanelWidth(settings.browserHeight, HEIGHT_MIN, HEIGHT_MAX)
  // 分区顺序/隐藏集合：未知 id 一律丢掉（版本升级后旧 id 不该一直占位）
  settings.toolOrder = normalizeToolOrder(settings.toolOrder)
  settings.toolHidden = normalizeToolHidden(settings.toolHidden)
  /* 磁贴布局：有版本化真源就归一化；没有就从旧的 order/hidden 一次性迁移 */
  const storedToolLayout = settings.toolLayout as { version?: unknown } | undefined
  settings.toolLayout = storedToolLayout && storedToolLayout.version !== undefined
    ? normalizeToolLayout(storedToolLayout, TOOL_SECTIONS)
    : migrateToolLayout(settings.toolOrder, settings.toolHidden, TOOL_SECTIONS)
  settings.toolHeights = normalizeHeights(settings.toolHeights)
  /*
   * toolDetail 的迁移历史（见 AppSettings.toolDetail 的注释）：
   *   v1  「已结束的能不能点开」—— 旧配置里的 false 只是默认值；
   *   v2  改成「运行中是否自动展开」，迁移时把老配置一律升为 true；
   *   v3（N03）默认值再改为 **收起**，且只有显式开关（toolDetailExplicit）
   *       才算用户偏好。v2 迁移强制写入的 true 是默认值、不是偏好，
   *       在 v3 里同样被重置 —— 否则升级后又会「自动展开干扰」。
   *   规则是幂等的：没有显式偏好的配置每次都归到 false。
   */
  if (settings.toolDetailExplicit !== true) {
    settings.toolDetail = false
  } else {
    // 显式偏好：非 true 一律当关（含缺失与脏值）
    settings.toolDetail = settings.toolDetail === true
  }
  settings.streamWidth = clampStreamWidth(settings.streamWidth)
  settings.autonomous = settings.autonomous === true
  /*
   * 工作模式（实施-05）：
   *   · `defaultWorkMode` 合法就听它的；否则拿旧 `autonomous === true`
   *     迁成 `autonomous`，其余 `standard` —— 迁移是幂等的（反复读同一份文件结果相同）。
   *   · 模式快捷键（2026-09-22）：开关只有明确写 `false` 才算关，其余（含缺失）
   *     保持 undefined = 开；旧字段 `workModeTab` 只在这里读一次（迁完不再写回）。
   *     组合键要过 `normalizeWorkModeShortcut`（脏值回落成「没设过」）。
   */
  settings.defaultWorkMode = migrateLegacyAutonomous(fileWorkMode, settings.autonomous)
  /* 提问频率：只认三档，脏值 / 缺失归到默认 `balanced` */
  settings.questionFrequency = normalizeQuestionFrequency(settings.questionFrequency)
  settings.codemodeEnabled = settings.codemodeEnabled !== false
  /* 旧档位迁到「危险批准」时关掉项目外写入确认（见 isLegacyPermissionMode） */
  settings.guardOutsideWrites = !isLegacyPermissionMode(settings.permissionMode) && settings.guardOutsideWrites === true
  settings.permissionMode = normalizePermissionMode(settings.permissionMode)
  settings.lastMainModel = cleanModelChoice(settings.lastMainModel)
  settings.lastSubagentModel = settings.lastSubagentModel === 'follow' ? 'follow' : cleanModelChoice(settings.lastSubagentModel)
  settings.modelFavorites = cleanModelFavorites(settings.modelFavorites)
  settings.modelProviderOrder = cleanProviderOrder(settings.modelProviderOrder)
  settings.checkpointsEnabled = settings.checkpointsEnabled !== false
  settings.guardAllowRoots = cleanAllowRoots(settings.guardAllowRoots)
  settings.capabilityStrategy =
    settings.capabilityStrategy === 'existing-only' || settings.capabilityStrategy === 'search-and-recommend'
      ? settings.capabilityStrategy
      : 'auto-connect'
  /*
   * 按活动配置模型（实施-25 P18）：认不出的模型名丢掉（不能让一个乱字符串
   * 变成「这个活动用某个不存在的模型」）。没配过时得到空配置。
   */
  settings.activityModels = sanitizeActivityModelConfig((parsed as { activityModels?: unknown }).activityModels)
  /* 旧字段只在这里读一次（迁完不再写回）：`workModeTab === false` 等价于关掉模式快捷键 */
  const legacyWorkModeTab = (settings as AppSettings & { workModeTab?: unknown }).workModeTab
  settings.workModeShortcutEnabled =
    settings.workModeShortcutEnabled === false || legacyWorkModeTab === false ? false : undefined
  settings.workModeShortcut = normalizeWorkModeShortcut(settings.workModeShortcut)
  settings.subagentNotify = settings.subagentNotify === false ? false : undefined
  settings.streamLoopAutoContinue = settings.streamLoopAutoContinue === false ? false : undefined
  settings.usageUnderInput = settings.usageUnderInput === false ? false : undefined
  // 发送键：只认三个已知值，脏值回落到 auto（默认行为）
  settings.sendKey =
    settings.sendKey === 'enter' || settings.sendKey === 'ctrlEnter' ? settings.sendKey : 'auto'
  // 回复详细程度：只认三个已知值，脏值 / 缺失回落到 standard
  settings.responseDetail =
    settings.responseDetail === 'brief' || settings.responseDetail === 'detailed'
      ? settings.responseDetail
      : 'standard'
  // 密度：只认三个已知值，脏值 / 缺失回落到 standard
  settings.density =
    settings.density === 'compact' || settings.density === 'comfortable'
      ? settings.density
      : 'standard'
  settings.sound = sanitizeSound(settings.sound)
  /*
   * 上下文策略覆盖（N21-7）：非法数值一律丢掉、越界值夹到区间。
   * 清洗后与默认值一致 → `undefined`，让“没改过”在磁盘上真的没有这个键。
   */
  settings.contextPolicy = sanitizeContextPolicyOverrides(settings.contextPolicy)
  settings.contextPolicyByModel = sanitizeContextPolicyByModel(settings.contextPolicyByModel)
  settings.temperatureByModel = cleanTemperatureByModel(settings.temperatureByModel)
  /*
   * Deep Context（N21-8）：只认字面 `true`。
   * 洗不进时结果是 `undefined`（而不是 `{enabled:false}`）—— 让「没改过」
   * 在磁盘上真的没有这个键，以后调默认值时才不会把改过的人一起改掉
   * （与 `railWidth: 0` / `contextPolicy` 同一个约定）。
   */
  settings.contextDeep = sanitizeContextDeep(settings.contextDeep)
  /*
   * `episode-fold` 的用户开关（P2-7）：同样是「没改过 = 磁盘上没有这个键」，
   * 只不过默认方向相反（它在默认接管集里，所以只有明确关闭才落盘）。
   */
  settings.contextFold = sanitizeContextFold(settings.contextFold)
  settings.projectKnowledge = sanitizeProjectKnowledge(settings.projectKnowledge)
  settings.remoteAccess = sanitizeRemoteAccess(settings.remoteAccess)
  /* 自动归档天数：0 / 脏值落成「没设置」，不写进文件 */
  settings.keepAwakeWhileWorking = settings.keepAwakeWhileWorking === false ? false : undefined
  settings.keepAwakeOnBattery = settings.keepAwakeOnBattery === false ? false : undefined
  settings.visualAnswers = settings.visualAnswers === false ? false : undefined
  /* 上下文裁剪与自动压缩：只有明确关才落 false；阈值只收档位里的值，缺省值不写进文件 */
  settings.contextTrim = settings.contextTrim === false ? false : undefined
  settings.contextTrimTokens = pickTokenStep(settings.contextTrimTokens, CONTEXT_TRIM_STEPS, DEFAULT_CONTEXT_TRIM_TOKENS)
  settings.autoCompactTokens = pickTokenStep(settings.autoCompactTokens, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS)
  settings.processLayout = settings.processLayout === 'side' || settings.processLayout === 'left' ? settings.processLayout : undefined
  settings.liveThinking = settings.liveThinking === true ? true : undefined
  {
    settings.backgroundPreset = typeof settings.backgroundPreset === 'string' && /^[a-z]{3,16}$/.test(settings.backgroundPreset) && settings.backgroundPreset !== 'default' ? settings.backgroundPreset : undefined
  }
  {
    settings.backgroundCustom = typeof settings.backgroundCustom === 'string' && /^#[0-9a-fA-F]{6}$/.test(settings.backgroundCustom) ? settings.backgroundCustom.toLowerCase() : undefined
  }
  {
    settings.backgroundCustomLight = typeof settings.backgroundCustomLight === 'string' && /^#[0-9a-fA-F]{6}$/.test(settings.backgroundCustomLight) ? settings.backgroundCustomLight.toLowerCase() : undefined
  }
  /* 字体与字号：只收预设 id、白名单字体名与区间内整数；缺省值不写进文件 */
  settings.fontUi = sanitizeFontUiPreset(settings.fontUi)
  settings.fontUiCustom = sanitizeFontName(settings.fontUiCustom)
  settings.fontCode = sanitizeFontCodePreset(settings.fontCode)
  settings.fontCodeCustom = sanitizeFontName(settings.fontCodeCustom)
  settings.fontSizeBody = sanitizeFontSize(settings.fontSizeBody, FONT_BODY_MIN, FONT_BODY_MAX, FONT_BODY_DEFAULT)
  settings.fontSizeUi = sanitizeFontSize(settings.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  settings.autoArchiveDays = normalizeAutoArchiveDays(settings.autoArchiveDays) || undefined
  settings.voiceInput = sanitizeVoiceInput(settings.voiceInput)
  settings.theme = settings.theme === 'light' ? 'light' : 'dark'
  settings.lang = LANGS.includes(parsed.lang as (typeof LANGS)[number]) ? parsed.lang! : detectLang()
  settings.toolDetailExplicit = settings.toolDetailExplicit === true ? true : undefined
  settings.showSpaces = settings.showSpaces === true ? true : undefined
  settings.recentCwds = settings.recentCwds.filter((cwd): cwd is string => typeof cwd === 'string' && !!cwd.trim()).filter((cwd, index, all) => all.indexOf(cwd) === index).slice(0, 8)
  settings.projectNames = Object.fromEntries(Object.entries(settings.projectNames)
    .filter(([path, name]) => path && typeof name === 'string' && !!name.trim())
    .map(([path, name]) => [path, name.trim().slice(0, 64)]))
  settings.providerBudgets = Object.fromEntries(Object.entries(settings.providerBudgets)
    .filter(([provider, budget]) => provider && typeof budget === 'number' && Number.isFinite(budget) && budget >= 0))
  return settings
}

export async function getSettings(): Promise<AppSettings> {
  if (cached) return structuredClone(cached)
  const generation = cacheGeneration
  let parsed: Partial<AppSettings>
  let text: string | undefined
  try {
    text = await readFile(FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`设置读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (text === undefined) parsed = {}
  else {
    try {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置文件必须是对象')
      parsed = value as Partial<AppSettings>
    } catch (error) {
      try { await copyFile(FILE, `${FILE}.corrupt-${randomUUID()}.bak`) } catch { /* 原文件仍保留，备份失败也不能覆写 */ }
      throw new Error(`设置解析失败，已拒绝覆盖：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof parsed.cwd !== 'string' || !parsed.cwd.trim() || !isAbsolute(parsed.cwd)) parsed.cwd = await defaultWorkFolder()
  const loaded = sanitizeSettings(parsed)
  // 直到默认目录及全部清洗完成才发布；期间发生更新则重新取得最新设置。
  if (generation !== cacheGeneration) return getSettings()
  cached = loaded
  return structuredClone(loaded)
}

/**
 * 手机接入设置：端口必须是非特权端口；监听地址只接受 tailscale / loopback 或一个 IPv4 字面量
 * （不接受 0.0.0.0 —— 需求稿要求网络可达不等于获得访问权，默认不对所有网卡开放）。
 */
function sanitizeRemoteAccess(value: unknown): AppSettings['remoteAccess'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const port = Number(raw.port)
  const bind = typeof raw.bind === 'string' ? raw.bind.trim() : 'tailscale'
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
  return {
    enabled: raw.enabled === true,
    bind: bind === 'tailscale' || bind === 'loopback' || (ipv4.test(bind) && bind !== '0.0.0.0') ? bind : 'tailscale',
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 37892,
    ...(sanitizeRelay(raw.relay) ? { relay: sanitizeRelay(raw.relay) } : {})
  }
}

/** 中继接入：只接受 http(s) / ws(s) 地址，不带路径以外的奇怪字符；地址无效时视为关闭。 */
function sanitizeRelay(value: unknown): NonNullable<AppSettings['remoteAccess']>['relay'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url.trim().slice(0, 300) : ''
  const valid = /^(https?|wss?):\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(url)
  return { enabled: raw.enabled === true && valid, url: valid ? url : '' }
}

/** 语音输入设置：模型只认目录里的 id 或绝对路径的 .bin；程序只认绝对路径的 .exe；语言三选一 */
function sanitizeVoiceInput(value: unknown): AppSettings['voiceInput'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const model = raw.model as { kind?: unknown; id?: unknown; path?: unknown } | undefined
  const isAbs = (p: unknown): p is string => typeof p === 'string' && /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
  const out: NonNullable<AppSettings['voiceInput']> = {}
  if (model?.kind === 'catalog' && typeof model.id === 'string' && voiceModelSpec(model.id)) out.model = { kind: 'catalog', id: model.id }
  else if (model?.kind === 'file' && isAbs(model.path) && /\.bin$/i.test(model.path)) out.model = { kind: 'file', path: model.path }
  if (isAbs(raw.binaryPath) && /\.exe$/i.test(raw.binaryPath)) out.binaryPath = raw.binaryPath
  if (raw.language === 'auto' || raw.language === 'zh' || raw.language === 'en') out.language = raw.language
  return Object.keys(out).length ? out : undefined
}

/** 允许写入的额外目录：只留非空字符串，去重，最多 30 个 */
function cleanAllowRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const roots: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string' || !isAbsolute(raw)) continue
    const candidate = resolve(raw)
    const volumeRoot = parse(candidate).root
    const systemRoots = new Set([`${volumeRoot}Windows`.toLowerCase(), '/system', '/usr', '/etc'])
    if (candidate === volumeRoot || systemRoots.has(candidate.toLowerCase())) continue
    try { if (statSync(candidate).isDirectory()) roots.push(candidate) } catch { /* missing/inaccessible roots are not trusted */ }
  }
  return [...new Set(roots)].slice(0, 30)
}

const RENDERER_SETTINGS_KEYS = new Set<string>(['lastMainModel','lastSubagentModel','modelFavorites','modelProviderOrder','showSpaces','cwd','theme','lang','recentCwds','projectNames','projects','projectGroups','projectOrder','providerBudgets','rightPanelOpen','alwaysOnTop','uiScale','profile','railWidth','panelWidth','browserHeight','toolOrder','toolHidden','toolHeights','toolDetail','toolDetailExplicit','streamWidth','autonomous','defaultWorkMode','questionFrequency','capabilityStrategy','codemodeEnabled','guardOutsideWrites','permissionMode','checkpointsEnabled','sendKey','responseDetail','density','sound','workspaceMode','toolLayout','activityModels','workModeShortcutEnabled','workModeShortcut','subagentNotify','streamLoopAutoContinue','usageUnderInput','contextPolicy','contextPolicyByModel','temperatureByModel','contextDeep','contextFold','projectKnowledge','remoteAccess','keepAwakeWhileWorking','keepAwakeOnBattery','visualAnswers','contextTrim','contextTrimTokens','autoCompactTokens','processLayout','liveThinking','backgroundPreset','backgroundCustom','backgroundCustomLight','fontUi','fontUiCustom','fontCode','fontCodeCustom','fontSizeBody','fontSizeUi','autoArchiveDays','voiceInput'])
export function validateRendererSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置补丁必须是对象')
  for (const key of Object.keys(value)) if (!RENDERER_SETTINGS_KEYS.has(key) || ['__proto__','constructor','prototype'].includes(key)) throw new Error(`不允许修改设置项：${key}`)
  return value as Partial<AppSettings>
}

export async function updateSettings(fn: (current: AppSettings) => Partial<AppSettings>): Promise<AppSettings> {
  const task = writeQueue.then(async () => applyPatch(fn(await getSettings())), async () => applyPatch(fn(await getSettings())))
  writeQueue = task.catch(() => undefined)
  return task
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  /* 排队：上一个写完才轮到本个（失败也不能断链） */
  const task = writeQueue.then(() => applyPatch(patch), () => applyPatch(patch))
  writeQueue = task.catch(() => undefined)
  return task
}

async function applyPatch(patch: Partial<AppSettings>): Promise<AppSettings> {
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
  let next: AppSettings = { ...cur, ...patch }
  if (typeof next.cwd !== 'string' || !next.cwd.trim() || !isAbsolute(next.cwd)) next.cwd = cur.cwd
  next.codemodeEnabled = next.codemodeEnabled !== false
  next.guardOutsideWrites = next.guardOutsideWrites === true
  next.permissionMode = normalizePermissionMode(next.permissionMode)
  next.lastMainModel = cleanModelChoice(next.lastMainModel)
  next.lastSubagentModel = next.lastSubagentModel === 'follow' ? 'follow' : cleanModelChoice(next.lastSubagentModel)
  next.modelFavorites = cleanModelFavorites(next.modelFavorites)
  next.modelProviderOrder = cleanProviderOrder(next.modelProviderOrder)
  next.checkpointsEnabled = next.checkpointsEnabled !== false
  next.guardAllowRoots = cleanAllowRoots(next.guardAllowRoots)

  if (Array.isArray(patch.recentCwds)) {
    // 去重、保留最近 8 个，只保留绝对路径字符串。
    next.recentCwds = [...new Set(patch.recentCwds.filter((path): path is string => typeof path === 'string' && isAbsolute(path)))].slice(0, 8)
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
  /* 按活动配置模型（实施-25 P18）：同样过 sanitize，脏值不落盘 */
  if ('activityModels' in patch) next.activityModels = sanitizeActivityModelConfig(patch.activityModels)
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
  /*
   * 上下文策略覆盖（N21-7）：写入前同样过一遍清洗。
   * 渲染端总是传**完整对象**（从当前设置派生），所以这里直接整体替换即可；
   * `triggerRatios` 是嵌套的，partial 传半边会被洗成只剩那几个键 ——
   * 这是可接受的：渲染端不拆分它。
   */
  if ('contextPolicy' in patch) next.contextPolicy = sanitizeContextPolicyOverrides(next.contextPolicy)
  if ('temperatureByModel' in patch) next.temperatureByModel = cleanTemperatureByModel(next.temperatureByModel)
  if ('contextPolicyByModel' in patch) {
    next.contextPolicyByModel = sanitizeContextPolicyByModel(next.contextPolicyByModel)
  }
  /*
   * Deep Context（N21-8）：关闭时写成 `undefined`（而不是 `{enabled:false}`），
   * 让「没改过」与「明确关掉」在磁盘上不一样 —— 否则以后改默认值时
   * 会把两类用户一起改掉。
   */
  if ('contextDeep' in patch) next.contextDeep = sanitizeContextDeep(next.contextDeep)
  /* 同上：关闭时写 `{enabled:false}`（它是「开着」的默认态），「没改过」写 `undefined` */
  if ('contextFold' in patch) next.contextFold = sanitizeContextFold(next.contextFold)
  if ('projectKnowledge' in patch) next.projectKnowledge = sanitizeProjectKnowledge(next.projectKnowledge)
  /* 工作模式（实施-05）：默认模式要合法；快捷键开关只有明确关才落 false，组合键要规范化 */
  if ('defaultWorkMode' in patch) next.defaultWorkMode = normalizeWorkMode(next.defaultWorkMode)
  if ('questionFrequency' in patch) next.questionFrequency = normalizeQuestionFrequency(next.questionFrequency)
  if ('workModeShortcutEnabled' in patch) {
    next.workModeShortcutEnabled = next.workModeShortcutEnabled === false ? false : undefined
  }
  if ('workModeShortcut' in patch) next.workModeShortcut = normalizeWorkModeShortcut(next.workModeShortcut)
  if ('remoteAccess' in patch) next.remoteAccess = sanitizeRemoteAccess(next.remoteAccess)
  /* 自动归档天数：0 / 脏值落成「没设置」，不写进文件 */
  if ('keepAwakeWhileWorking' in patch) next.keepAwakeWhileWorking = next.keepAwakeWhileWorking === false ? false : undefined
  if ('keepAwakeOnBattery' in patch) next.keepAwakeOnBattery = next.keepAwakeOnBattery === false ? false : undefined
  if ('visualAnswers' in patch) next.visualAnswers = next.visualAnswers === false ? false : undefined
  /* 上下文裁剪与自动压缩：只有明确关才落 false；阈值只收档位里的值，缺省值不写进文件 */
  if ('contextTrim' in patch) next.contextTrim = next.contextTrim === false ? false : undefined
  if ('contextTrimTokens' in patch) next.contextTrimTokens = pickTokenStep(next.contextTrimTokens, CONTEXT_TRIM_STEPS, DEFAULT_CONTEXT_TRIM_TOKENS)
  if ('autoCompactTokens' in patch) next.autoCompactTokens = pickTokenStep(next.autoCompactTokens, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS)
  if ('processLayout' in patch) next.processLayout = next.processLayout === 'side' || next.processLayout === 'left' ? next.processLayout : undefined
  if ('liveThinking' in patch) next.liveThinking = next.liveThinking === true ? true : undefined
  if ('backgroundPreset' in patch) {
    next.backgroundPreset = typeof next.backgroundPreset === 'string' && /^[a-z]{3,16}$/.test(next.backgroundPreset) && next.backgroundPreset !== 'default' ? next.backgroundPreset : undefined
  }
  if ('backgroundCustom' in patch) {
    next.backgroundCustom = typeof next.backgroundCustom === 'string' && /^#[0-9a-fA-F]{6}$/.test(next.backgroundCustom) ? next.backgroundCustom.toLowerCase() : undefined
  }
  if ('backgroundCustomLight' in patch) {
    next.backgroundCustomLight = typeof next.backgroundCustomLight === 'string' && /^#[0-9a-fA-F]{6}$/.test(next.backgroundCustomLight) ? next.backgroundCustomLight.toLowerCase() : undefined
  }
  /* 字体与字号：只收预设 id、白名单字体名与区间内整数；缺省值不写进文件 */
  if ('fontUi' in patch) next.fontUi = sanitizeFontUiPreset(next.fontUi)
  if ('fontUiCustom' in patch) next.fontUiCustom = sanitizeFontName(next.fontUiCustom)
  if ('fontCode' in patch) next.fontCode = sanitizeFontCodePreset(next.fontCode)
  if ('fontCodeCustom' in patch) next.fontCodeCustom = sanitizeFontName(next.fontCodeCustom)
  if ('fontSizeBody' in patch) next.fontSizeBody = sanitizeFontSize(next.fontSizeBody, FONT_BODY_MIN, FONT_BODY_MAX, FONT_BODY_DEFAULT)
  if ('fontSizeUi' in patch) next.fontSizeUi = sanitizeFontSize(next.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  if ('autoArchiveDays' in patch) next.autoArchiveDays = normalizeAutoArchiveDays(next.autoArchiveDays) || undefined
  if ('voiceInput' in patch) next.voiceInput = sanitizeVoiceInput(next.voiceInput)
  // 旧的路径 → 名称映射同步到实体，之后 UI 可以只依赖 projects。
  next.projects = sanitizeProjects(next.projects, next.projectNames, next.recentCwds, next.cwd).map((project) => ({
    ...project,
    name: next.projectNames[project.cwd] ?? project.name,
    groupId: next.projectGroups.some((g) => g.id === project.groupId) ? project.groupId : undefined
  }))
  /*
   * 项目顺序（N01）：统一在这里过一遍（而不是在 patch 分派里），
   * 保证无论本次 patch 是否带 projectOrder，落盘的都是「只含真实项目」的集合。
   */
  next.projectOrder = sanitizeProjectOrder(next.projectOrder)
    .filter((id) => next.projects.some((project) => project.id === id))

  next = sanitizeSettings(next)
  const temp = `${FILE}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(DIR, { recursive: true })
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temp, FILE)
    try {
      const dir = await open(DIR, 'r')
      try { await dir.sync() } finally { await dir.close() }
    } catch { /* 部分平台不支持目录 fsync */ }
  } catch (e) {
    /*
     * 写盘失败必须如实回报：不能更新缓存、更不能返回“已保存”的新设置。
     * 否则界面显示成功、重启后变回旧值，而调用方没有任何办法发现。
     * `invalidate()` 让下一次读取回到磁盘上的真实状态。
     */
    await unlink(temp).catch(() => undefined)
    invalidate()
    throw new Error(`设置写入失败：${e instanceof Error ? e.message : String(e)}`)
  }
  cacheGeneration++
  cached = next
  return structuredClone(next)
}
