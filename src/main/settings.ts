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
import { normalizeUsageCurrency } from '../shared/currency'
import { FONT_BODY_DEFAULT, FONT_BODY_MAX, FONT_BODY_MIN, FONT_UI_DEFAULT, FONT_UI_MAX, FONT_UI_MIN, sanitizeFontCodePreset, sanitizeFontName, sanitizeFontSize, sanitizeFontUiPreset } from '../shared/appearance'

const DIR = YAN_DIR
const FILE = join(DIR, 'desktop.json')

function cleanTemperatureByModel(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) out[key] = Math.round(value * 100) / 100
  }
  return Object.keys(out).length ? out : undefined
}

const LANGS = ['zh-CN', 'en-US'] as const
function detectLang(): (typeof LANGS)[number] {
  try {
    const l = (app.getLocale?.() || '').toLowerCase()
    if (l) return l.startsWith('zh') ? 'zh-CN' : 'en-US'
  } catch {
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
  lang: 'zh-CN',
  recentCwds: [],
  projectNames: {},
  projects: [],
  projectGroups: [],
  projectOrder: [],
  providerBudgets: {},
  rightPanelOpen: true,
  alwaysOnTop: false,
  uiScale: 0,
  profile: defaultProfile(),
  railWidth: 0,
  panelWidth: 0,
  browserHeight: 0,
  toolOrder: [],
  toolHidden: [],
  toolHeights: {},
  toolDetail: false,
  streamWidth: 0,
  autonomous: false,
  defaultWorkMode: DEFAULT_WORK_MODE,
  questionFrequency: DEFAULT_QUESTION_FREQUENCY,
  capabilityStrategy: 'auto-connect',
  codemodeEnabled: true,
  guardOutsideWrites: false,
  permissionMode: DEFAULT_PERMISSION_MODE,
  guardAllowRoots: [],
  checkpointsEnabled: true,
  sendKey: 'auto',
  responseDetail: 'standard',
  density: 'standard',
  sound: defaultSound()
}

function defaultSound(): SoundSettings {
  return {
    enabled: false,
    volume: 0.4,
    notifications: true,
    events: { done: true, question: true, error: true }
  }
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

function defaultProfile(): UserProfile {
  let name = ''
  try {
    name = userInfo().username ?? ''
  } catch {
  }
  return {
    name,
    avatarKind: 'letter',
    avatarValue: '',
    avatarHue: -1,
    signedIn: false
  }
}

function sanitizeProfile(v: unknown): UserProfile {
  const d = defaultProfile()
  if (!v || typeof v !== 'object') return d
  const o = v as Partial<UserProfile> & Record<string, unknown>
  const kind = o.avatarKind === 'icon' ? 'icon' : 'letter'
  const hueRaw = typeof o.avatarHue === 'number' ? o.avatarHue : -1
  return {
    name: typeof o.name === 'string' ? o.name.slice(0, 32) : d.name,
    avatarKind: kind,
    avatarValue: typeof o.avatarValue === 'string' ? o.avatarValue.slice(0, 32) : '',
    avatarHue: Number.isFinite(hueRaw) ? Math.min(360, Math.max(-1, hueRaw)) : -1,
    signedIn: false
  }
}

function projectId(cwd: string, isTaken?: (id: string) => boolean): string {
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

let writeQueue: Promise<unknown> = Promise.resolve()

function invalidate(): void {
  cacheGeneration++
  cached = null
}

async function defaultWorkFolder(): Promise<string> {
  let documents = join(homedir(), 'Documents')
  try {
    documents = app.getPath('documents')
  } catch {
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
  const fileWorkMode = parsed.defaultWorkMode
  if (!LANGS.includes(settings.lang as (typeof LANGS)[number])) settings.lang = detectLang()
  if (settings.theme !== 'light' && settings.theme !== 'dark') settings.theme = 'dark'
  if (!Array.isArray(settings.recentCwds)) settings.recentCwds = []
  if (!settings.projectNames || typeof settings.projectNames !== 'object' || Array.isArray(settings.projectNames)) settings.projectNames = {}
  settings.projectGroups = sanitizeProjectGroups(settings.projectGroups)
  settings.projects = sanitizeProjects(settings.projects, settings.projectNames, settings.recentCwds, settings.cwd)
  const knownProjects = settings.projects
  settings.projectOrder = sanitizeProjectOrder(settings.projectOrder)
    .filter((id) => knownProjects.some((project) => project.id === id))
  if (!settings.providerBudgets || typeof settings.providerBudgets !== 'object' || Array.isArray(settings.providerBudgets)) settings.providerBudgets = {}
  if (typeof settings.rightPanelOpen !== 'boolean') settings.rightPanelOpen = true
  settings.workspaceMode = isWorkspaceMode(settings.workspaceMode) ? settings.workspaceMode : undefined
  settings.alwaysOnTop = settings.alwaysOnTop === true
  settings.uiScale = clampScale(settings.uiScale)
  settings.profile = sanitizeProfile(settings.profile)
  settings.railWidth = clampPanelWidth(settings.railWidth, RAIL_MIN, RAIL_MAX)
  settings.panelWidth = clampPanelWidth(settings.panelWidth, PANEL_MIN, PANEL_MAX)
  settings.browserHeight = clampPanelWidth(settings.browserHeight, HEIGHT_MIN, HEIGHT_MAX)
  settings.toolOrder = normalizeToolOrder(settings.toolOrder)
  settings.toolHidden = normalizeToolHidden(settings.toolHidden)
  const storedToolLayout = settings.toolLayout as { version?: unknown } | undefined
  settings.toolLayout = storedToolLayout && storedToolLayout.version !== undefined
    ? normalizeToolLayout(storedToolLayout, TOOL_SECTIONS)
    : migrateToolLayout(settings.toolOrder, settings.toolHidden, TOOL_SECTIONS)
  settings.toolHeights = normalizeHeights(settings.toolHeights)
  if (settings.toolDetailExplicit !== true) {
    settings.toolDetail = false
  } else {
    settings.toolDetail = settings.toolDetail === true
  }
  settings.streamWidth = clampStreamWidth(settings.streamWidth)
  settings.autonomous = settings.autonomous === true
  settings.defaultWorkMode = migrateLegacyAutonomous(fileWorkMode, settings.autonomous)
  settings.questionFrequency = normalizeQuestionFrequency(settings.questionFrequency)
  settings.codemodeEnabled = settings.codemodeEnabled !== false
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
  const legacyWorkModeTab = (settings as AppSettings & { workModeTab?: unknown }).workModeTab
  settings.workModeShortcutEnabled =
    settings.workModeShortcutEnabled === false || legacyWorkModeTab === false ? false : undefined
  settings.workModeShortcut = normalizeWorkModeShortcut(settings.workModeShortcut)
  settings.subagentNotify = settings.subagentNotify === false ? false : undefined
  settings.streamLoopAutoContinue = settings.streamLoopAutoContinue === false ? false : undefined
  settings.usageUnderInput = settings.usageUnderInput === false ? false : undefined
  settings.usageCurrency = normalizeUsageCurrency(settings.usageCurrency)
  settings.sendKey =
    settings.sendKey === 'enter' || settings.sendKey === 'ctrlEnter' ? settings.sendKey : 'auto'
  settings.responseDetail =
    settings.responseDetail === 'brief' || settings.responseDetail === 'detailed'
      ? settings.responseDetail
      : 'standard'
  settings.density =
    settings.density === 'compact' || settings.density === 'comfortable'
      ? settings.density
      : 'standard'
  settings.sound = sanitizeSound(settings.sound)
  settings.temperatureByModel = cleanTemperatureByModel(settings.temperatureByModel)
  settings.remoteAccess = sanitizeRemoteAccess(settings.remoteAccess)
  settings.keepAwakeWhileWorking = settings.keepAwakeWhileWorking === false ? false : undefined
  settings.keepAwakeOnBattery = settings.keepAwakeOnBattery === false ? false : undefined
  settings.visualAnswers = settings.visualAnswers === false ? false : undefined
  settings.asciiBackground = settings.asciiBackground === false ? false : undefined
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
      try { await copyFile(FILE, `${FILE}.corrupt-${randomUUID()}.bak`) } catch { }
      throw new Error(`设置解析失败，已拒绝覆盖：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof parsed.cwd !== 'string' || !parsed.cwd.trim() || !isAbsolute(parsed.cwd)) parsed.cwd = await defaultWorkFolder()
  const loaded = sanitizeSettings(parsed)
  if (generation !== cacheGeneration) return getSettings()
  cached = loaded
  return structuredClone(loaded)
}

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

function sanitizeRelay(value: unknown): NonNullable<AppSettings['remoteAccess']>['relay'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url.trim().slice(0, 300) : ''
  const valid = /^(https?|wss?):\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(url)
  return { enabled: raw.enabled === true && valid, url: valid ? url : '' }
}

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

function cleanAllowRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const roots: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string' || !isAbsolute(raw)) continue
    const candidate = resolve(raw)
    const volumeRoot = parse(candidate).root
    const systemRoots = new Set([`${volumeRoot}Windows`.toLowerCase(), '/system', '/usr', '/etc'])
    if (candidate === volumeRoot || systemRoots.has(candidate.toLowerCase())) continue
    try { if (statSync(candidate).isDirectory()) roots.push(candidate) } catch { }
  }
  return [...new Set(roots)].slice(0, 30)
}

const RENDERER_SETTINGS_KEYS = new Set<string>(['lastMainModel','lastSubagentModel','modelFavorites','modelProviderOrder','cwd','theme','lang','recentCwds','projectNames','projects','projectGroups','projectOrder','providerBudgets','rightPanelOpen','alwaysOnTop','uiScale','profile','railWidth','panelWidth','browserHeight','toolOrder','toolHidden','toolHeights','toolDetail','toolDetailExplicit','streamWidth','autonomous','defaultWorkMode','questionFrequency','capabilityStrategy','codemodeEnabled','asciiBackground','guardOutsideWrites','permissionMode','checkpointsEnabled','sendKey','responseDetail','density','sound','workspaceMode','toolLayout','workModeShortcutEnabled','workModeShortcut','subagentNotify','streamLoopAutoContinue','usageUnderInput','usageCurrency','temperatureByModel','remoteAccess','keepAwakeWhileWorking','keepAwakeOnBattery','visualAnswers','contextTrim','contextTrimTokens','autoCompactTokens','processLayout','liveThinking','backgroundPreset','backgroundCustom','backgroundCustomLight','fontUi','fontUiCustom','fontCode','fontCodeCustom','fontSizeBody','fontSizeUi','autoArchiveDays','voiceInput','shortcutOverrides'])
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
  const task = writeQueue.then(() => applyPatch(patch), () => applyPatch(patch))
  writeQueue = task.catch(() => undefined)
  return task
}

async function applyPatch(patch: Partial<AppSettings>): Promise<AppSettings> {
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
  next.usageCurrency = normalizeUsageCurrency(next.usageCurrency)

  if (Array.isArray(patch.recentCwds)) {
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
  next.profile = sanitizeProfile({ ...next.profile, ...(patch.profile ?? {}) })
  if ('railWidth' in patch) next.railWidth = clampPanelWidth(next.railWidth, RAIL_MIN, RAIL_MAX)
  if ('panelWidth' in patch) next.panelWidth = clampPanelWidth(next.panelWidth, PANEL_MIN, PANEL_MAX)
  if ('browserHeight' in patch) next.browserHeight = clampPanelWidth(next.browserHeight, HEIGHT_MIN, HEIGHT_MAX)
  if ('streamWidth' in patch) next.streamWidth = clampStreamWidth(next.streamWidth)
  if ('sound' in patch) {
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
  if ('temperatureByModel' in patch) next.temperatureByModel = cleanTemperatureByModel(next.temperatureByModel)
  if ('defaultWorkMode' in patch) next.defaultWorkMode = normalizeWorkMode(next.defaultWorkMode)
  if ('questionFrequency' in patch) next.questionFrequency = normalizeQuestionFrequency(next.questionFrequency)
  if ('workModeShortcutEnabled' in patch) {
    next.workModeShortcutEnabled = next.workModeShortcutEnabled === false ? false : undefined
  }
  if ('workModeShortcut' in patch) next.workModeShortcut = normalizeWorkModeShortcut(next.workModeShortcut)
  if ('remoteAccess' in patch) next.remoteAccess = sanitizeRemoteAccess(next.remoteAccess)
  if ('keepAwakeWhileWorking' in patch) next.keepAwakeWhileWorking = next.keepAwakeWhileWorking === false ? false : undefined
  if ('keepAwakeOnBattery' in patch) next.keepAwakeOnBattery = next.keepAwakeOnBattery === false ? false : undefined
  if ('visualAnswers' in patch) next.visualAnswers = next.visualAnswers === false ? false : undefined
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
  if ('fontUi' in patch) next.fontUi = sanitizeFontUiPreset(next.fontUi)
  if ('fontUiCustom' in patch) next.fontUiCustom = sanitizeFontName(next.fontUiCustom)
  if ('fontCode' in patch) next.fontCode = sanitizeFontCodePreset(next.fontCode)
  if ('fontCodeCustom' in patch) next.fontCodeCustom = sanitizeFontName(next.fontCodeCustom)
  if ('fontSizeBody' in patch) next.fontSizeBody = sanitizeFontSize(next.fontSizeBody, FONT_BODY_MIN, FONT_BODY_MAX, FONT_BODY_DEFAULT)
  if ('fontSizeUi' in patch) next.fontSizeUi = sanitizeFontSize(next.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  if ('autoArchiveDays' in patch) next.autoArchiveDays = normalizeAutoArchiveDays(next.autoArchiveDays) || undefined
  if ('voiceInput' in patch) next.voiceInput = sanitizeVoiceInput(next.voiceInput)
  next.projects = sanitizeProjects(next.projects, next.projectNames, next.recentCwds, next.cwd).map((project) => ({
    ...project,
    name: next.projectNames[project.cwd] ?? project.name,
    groupId: next.projectGroups.some((g) => g.id === project.groupId) ? project.groupId : undefined
  }))
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
    } catch { }
  } catch (e) {
    await unlink(temp).catch(() => undefined)
    invalidate()
    throw new Error(`设置写入失败：${e instanceof Error ? e.message : String(e)}`)
  }
  cacheGeneration++
  cached = next
  return structuredClone(next)
}
