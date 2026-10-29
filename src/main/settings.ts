import { readFile, mkdir, copyFile, rename } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, parse, resolve } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { cleanModelChoice, cleanModelFavorites, cleanModelHidden, cleanProviderOrder } from '../shared/model-selection'
import {
  SOUND_VOLUME_MAX,
  SOUND_VOLUME_MIN,
  type AppSettings,
  type ProjectRecord,
  type SoundSettings,
  type UserProfile
} from '../shared/ipc'
import { YAN_DIR } from './paths'
import { clampScale } from './zoom-math'
import { projectIdForCwd } from './project-id'
import { DEFAULT_PERMISSION_MODE, isLegacyPermissionMode, normalizePermissionMode } from '../shared/approval'
import { AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS, pickTokenStep } from '../shared/context-limits'
import { isWorkspaceMode } from '../shared/workspace-mode'
import { voiceModelSpec } from '../shared/voice-input'
import { normalizeAutoArchiveDays } from '../shared/session-archive'
import { normalizeUsageCurrency } from '../shared/currency'
import { FONT_UI_DEFAULT, FONT_UI_MAX, FONT_UI_MIN, sanitizeFontCodePreset, sanitizeFontName, sanitizeFontSize, sanitizeFontUiPreset, sanitizeStreamWidth } from '../shared/appearance'
import { allowedSiteList } from './preview-site-access'
import { sanitizeProjectScripts } from '../shared/project-scripts'
import { electronGuardSealStore, guardFieldsOf, sameGuardFields, trustedGuardFields, type GuardFields } from './settings-guard-seal'
import { atomicWriteFile } from './sync/atomic'

const DIR = YAN_DIR
const FILE = join(DIR, 'desktop.json')

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
  projectScripts: {},
  providerBudgets: {},
  rightPanelOpen: true,
  alwaysOnTop: false,
  uiScale: 0,
  profile: defaultProfile(),
  codemodeEnabled: true,
  guardOutsideWrites: true,
  permissionMode: DEFAULT_PERMISSION_MODE,
  guardAllowRoots: [],
  browserAllowedSites: [],
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
    out.push({ id: o.id.slice(0, 80), cwd: o.cwd, name: typeof o.name === 'string' ? o.name.trim().slice(0, 64) : '', archived: o.archived === true, createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : now, updatedAt: Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : now })
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

let cached: AppSettings | null = null
let cacheGeneration = 0

let writeQueue: Promise<unknown> = Promise.resolve()

const GUARD_TAMPERED_NOTICE = '检测到权限设置被砚以外的程序改动，已恢复为你在设置里选择的档位。'
const GUARD_UNSEALED_NOTICE = '权限档没有可核对的加密记录（首次升级或记录丢失），已回到「自动批准」；需要「不受限制」请在设置里重新选择。'
let guardNoticeSink: ((message: string) => void) | null = null
let pendingGuardNotices: string[] = []
let lastGuardNoticeKey = ''

export function setGuardSettingsNoticeSink(sink: (message: string) => void): void {
  guardNoticeSink = sink
  const messages = pendingGuardNotices
  pendingGuardNotices = []
  for (const message of messages) sink(message)
}

function noticeGuardSettings(message: string, key: string): void {
  if (key === lastGuardNoticeKey) return
  lastGuardNoticeKey = key
  if (guardNoticeSink) guardNoticeSink(message)
  else pendingGuardNotices.push(message)
}

async function enforceGuardSeal(settings: AppSettings, quiet = false): Promise<AppSettings> {
  const store = await electronGuardSealStore()
  if (!store) return settings
  const file = guardFieldsOf(settings)
  const seal = await store.read()
  const trusted = trustedGuardFields(file, seal)
  if (!seal || !sameGuardFields(seal, trusted)) await store.write(trusted).catch(() => undefined)
  if (!sameGuardFields(file, trusted)) {
    if (!quiet) noticeGuardSettings(seal ? GUARD_TAMPERED_NOTICE : GUARD_UNSEALED_NOTICE, JSON.stringify(file))
    void patchSettings({}).catch(() => undefined)
  }
  return { ...settings, ...trusted }
}

export async function dangerGuardPrefs(): Promise<{ mode: GuardFields['permissionMode']; outsideWrites: boolean; allowRoots: string[] }> {
  const fields = guardFieldsOf(await getSettings())
  return { mode: fields.permissionMode, outsideWrites: fields.guardOutsideWrites, allowRoots: fields.guardAllowRoots }
}

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
  const { contextTrim: _contextTrim, contextTrimTokens: _contextTrimTokens, ...remaining } = parsed as Partial<AppSettings> & { contextTrim?: unknown; contextTrimTokens?: unknown }
  const current = Object.fromEntries(Object.entries(remaining).filter(([key]) => !/^(desktopPet|comfy)/i.test(key)))
  const settings = { ...DEFAULTS, ...current } as AppSettings
  if (settings.theme !== 'light' && settings.theme !== 'dark') settings.theme = 'dark'
  if (!Array.isArray(settings.recentCwds)) settings.recentCwds = []
  if (!settings.projectNames || typeof settings.projectNames !== 'object' || Array.isArray(settings.projectNames)) settings.projectNames = {}
  settings.projects = sanitizeProjects(settings.projects, settings.projectNames, settings.recentCwds, settings.cwd)
  settings.projectScripts = sanitizeProjectScripts(settings.projectScripts)
  if (!settings.providerBudgets || typeof settings.providerBudgets !== 'object' || Array.isArray(settings.providerBudgets)) settings.providerBudgets = {}
  if (typeof settings.rightPanelOpen !== 'boolean') settings.rightPanelOpen = true
  settings.workspaceMode = isWorkspaceMode(settings.workspaceMode) ? settings.workspaceMode : undefined
  settings.alwaysOnTop = settings.alwaysOnTop === true
  settings.uiScale = clampScale(settings.uiScale)
  settings.profile = sanitizeProfile(settings.profile)
  settings.codemodeEnabled = settings.codemodeEnabled !== false
  settings.guardOutsideWrites = !isLegacyPermissionMode(settings.permissionMode) && settings.guardOutsideWrites === true
  settings.permissionMode = normalizePermissionMode(settings.permissionMode)
  settings.lastMainModel = cleanModelChoice(settings.lastMainModel)
  settings.lastSubagentModel = settings.lastSubagentModel === 'follow' ? 'follow' : cleanModelChoice(settings.lastSubagentModel)
  settings.subagentDefaultModel = cleanModelChoice(settings.subagentDefaultModel)
  settings.subagentModelForce = settings.subagentDefaultModel && settings.subagentModelForce === true ? true : undefined
  settings.modelFavorites = cleanModelFavorites(settings.modelFavorites)
  settings.modelHidden = cleanModelHidden(settings.modelHidden)
  settings.modelProviderOrder = cleanProviderOrder(settings.modelProviderOrder)
  settings.checkpointsEnabled = settings.checkpointsEnabled !== false
  settings.guardAllowRoots = cleanAllowRoots(settings.guardAllowRoots)
  settings.browserAllowedSites = allowedSiteList(settings.browserAllowedSites)
  settings.subagentNotify = settings.subagentNotify === false ? false : undefined
  settings.streamLoopAutoContinue = settings.streamLoopAutoContinue === false ? false : undefined
  settings.workspaceTiles = settings.workspaceTiles === false ? false : undefined
  settings.smoothText = settings.smoothText === true ? true : undefined
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
  settings.remoteAccess = sanitizeRemoteAccess(settings.remoteAccess)
  settings.keepAwakeWhileWorking = settings.keepAwakeWhileWorking === false ? false : undefined
  settings.keepAwakeOnBattery = settings.keepAwakeOnBattery === false ? false : undefined
  settings.visualAnswers = settings.visualAnswers === false ? false : undefined
  settings.wrapUpCard = settings.wrapUpCard === false ? false : undefined
  settings.asciiBackground = settings.asciiBackground === false ? false : undefined
  settings.autoCompactTokens = pickTokenStep(settings.autoCompactTokens, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS)
  settings.fontUi = sanitizeFontUiPreset(settings.fontUi)
  settings.fontUiCustom = sanitizeFontName(settings.fontUiCustom)
  settings.fontCode = sanitizeFontCodePreset(settings.fontCode)
  settings.fontCodeCustom = sanitizeFontName(settings.fontCodeCustom)
  settings.fontSizeUi = sanitizeFontSize(settings.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  settings.streamWidth = sanitizeStreamWidth(settings.streamWidth)
  settings.reduceMotion = settings.reduceMotion === true ? true : undefined
  settings.sidebarLayout = settings.sidebarLayout === 'flat' ? 'flat' : undefined
  settings.autoArchiveDays = typeof settings.autoArchiveDays === 'number' ? normalizeAutoArchiveDays(settings.autoArchiveDays) : undefined
  settings.voiceInput = sanitizeVoiceInput(settings.voiceInput)
  settings.theme = settings.theme === 'light' ? 'light' : 'dark'
  settings.lang = LANGS.includes(parsed.lang as (typeof LANGS)[number]) ? parsed.lang! : detectLang()
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
  let healedBackup: string | null = null
  if (text === undefined) parsed = {}
  else {
    try {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置文件必须是对象')
      parsed = value as Partial<AppSettings>
    } catch (error) {
      const backup = `${FILE}.corrupt-${randomUUID()}.bak`
      try {
        await rename(FILE, backup)
      } catch {
        try {
          await copyFile(FILE, backup)
        } catch {
          throw new Error(`设置解析失败，且无法备份原文件，已拒绝覆盖：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      parsed = {}
      healedBackup = backup
    }
  }
  if (typeof parsed.cwd !== 'string' || !parsed.cwd.trim() || !isAbsolute(parsed.cwd)) parsed.cwd = await defaultWorkFolder()
  const loaded = await enforceGuardSeal(sanitizeSettings(parsed), healedBackup !== null)
  if (healedBackup) noticeGuardSettings(`设置文件损坏，已备份为 ${basename(healedBackup)}，这次用默认设置启动（权限档按加密记录恢复）。`, `heal:${healedBackup}`)
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
    bind: bind === 'tailscale' || bind === 'radmin' || bind === 'loopback' || (ipv4.test(bind) && bind !== '0.0.0.0') ? bind : 'tailscale',
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

const RENDERER_SETTINGS_KEYS = new Set<string>(['lastMainModel','lastSubagentModel','subagentDefaultModel','subagentModelForce','modelFavorites','modelHidden','modelProviderOrder','cwd','theme','lang','recentCwds','projectNames','projects','projectScripts','providerBudgets','rightPanelOpen','alwaysOnTop','uiScale','profile','codemodeEnabled','asciiBackground','guardOutsideWrites','permissionMode','checkpointsEnabled','sendKey','responseDetail','density','sound','workspaceMode','subagentNotify','streamLoopAutoContinue','wrapUpCard','workspaceTiles','smoothText','usageCurrency','remoteAccess','keepAwakeWhileWorking','keepAwakeOnBattery','visualAnswers','autoCompactTokens','fontUi','fontUiCustom','fontCode','fontCodeCustom','fontSizeUi','streamWidth','reduceMotion','sidebarLayout','autoArchiveDays','voiceInput','shortcutOverrides'])
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
  next.subagentDefaultModel = cleanModelChoice(next.subagentDefaultModel)
  next.subagentModelForce = next.subagentDefaultModel && next.subagentModelForce === true ? true : undefined
  next.modelFavorites = cleanModelFavorites(next.modelFavorites)
  next.modelHidden = cleanModelHidden(next.modelHidden)
  next.modelProviderOrder = cleanProviderOrder(next.modelProviderOrder)
  next.checkpointsEnabled = next.checkpointsEnabled !== false
  next.guardAllowRoots = cleanAllowRoots(next.guardAllowRoots)
  next.browserAllowedSites = allowedSiteList(next.browserAllowedSites)
  next.usageCurrency = normalizeUsageCurrency(next.usageCurrency)
  next.sidebarLayout = next.sidebarLayout === 'flat' ? 'flat' : undefined

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
  next.profile = sanitizeProfile({ ...next.profile, ...(patch.profile ?? {}) })
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
  if ('remoteAccess' in patch) next.remoteAccess = sanitizeRemoteAccess(next.remoteAccess)
  if ('keepAwakeWhileWorking' in patch) next.keepAwakeWhileWorking = next.keepAwakeWhileWorking === false ? false : undefined
  if ('keepAwakeOnBattery' in patch) next.keepAwakeOnBattery = next.keepAwakeOnBattery === false ? false : undefined
  if ('visualAnswers' in patch) next.visualAnswers = next.visualAnswers === false ? false : undefined
  if ('wrapUpCard' in patch) next.wrapUpCard = next.wrapUpCard === false ? false : undefined
  if ('autoCompactTokens' in patch) next.autoCompactTokens = pickTokenStep(next.autoCompactTokens, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS)
  if ('fontUi' in patch) next.fontUi = sanitizeFontUiPreset(next.fontUi)
  if ('fontUiCustom' in patch) next.fontUiCustom = sanitizeFontName(next.fontUiCustom)
  if ('fontCode' in patch) next.fontCode = sanitizeFontCodePreset(next.fontCode)
  if ('fontCodeCustom' in patch) next.fontCodeCustom = sanitizeFontName(next.fontCodeCustom)
  if ('fontSizeUi' in patch) next.fontSizeUi = sanitizeFontSize(next.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  if ('autoArchiveDays' in patch) next.autoArchiveDays = typeof next.autoArchiveDays === 'number' ? normalizeAutoArchiveDays(next.autoArchiveDays) : undefined
  if ('voiceInput' in patch) next.voiceInput = sanitizeVoiceInput(next.voiceInput)
  next.projects = sanitizeProjects(next.projects, next.projectNames, next.recentCwds, next.cwd).map((project) => ({
    ...project,
    name: next.projectNames[project.cwd] ?? project.name
  }))

  next = sanitizeSettings(next)
  const sealStore = await electronGuardSealStore()
  const guardChanged = !sameGuardFields(guardFieldsOf(cur), guardFieldsOf(next))
  let sealWritten = false
  try {
    if (sealStore && guardChanged) {
      await sealStore.write(guardFieldsOf(next))
      sealWritten = true
    }
    await atomicWriteFile(FILE, JSON.stringify(next, null, 2), { syncDir: true })
  } catch (e) {
    if (sealStore && sealWritten) await sealStore.write(guardFieldsOf(cur)).catch(() => undefined)
    invalidate()
    throw new Error(`设置写入失败：${e instanceof Error ? e.message : String(e)}`)
  }
  cacheGeneration++
  cached = next
  return structuredClone(next)
}
