/**
 * 原生会话面板（模型循环范围 / 项目信任 / 原始条目）的共享口径。
 *
 * 这里是**纯逻辑**：不碰 React、不读 store、不调 Electron；面板组件只负责把这份
 * 数据画出来，请求通过 `NativeSurfaceTransport` 交给宿主桥。这样做有两个边界：
 *   · 请求与结果形状只对 `shared/native-session-host.ts` 说话，不复制 pi 的内部循环；
 *   · 迟到响应、体积上限、空/错误态都在纯函数里收口，组件不各写一套判断。
 *
 * `entries` 只读：本模块只投影与限量，不提供任何写动作。
 */
import type { Lang } from '../../../i18n'
import { describeEntry, nativeModelKey, nativeOneLine, type NativeEntryKind } from '../../../../../shared/native-session'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../../shared/native-session-host'

/* ------------------------------------------------------------------ 模式 */

export const NATIVE_SURFACE_MODES = ['scoped-models', 'trust', 'entries'] as const
export type NativeSurfaceMode = (typeof NATIVE_SURFACE_MODES)[number]

/** 面板信号里可能出现的模式；`tree` 由分支树消费，不属于本模块。 */
export function isNativeSurfaceMode(value: unknown): value is NativeSurfaceMode {
  return typeof value === 'string' && (NATIVE_SURFACE_MODES as readonly string[]).includes(value)
}

/** 原生会话桥的最小接口面，与 `shared/native-session-host.ts` 的请求 / 结果一一对应。 */
export interface NativeSurfaceTransport {
  request: (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>
}

/* ------------------------------------------------------------------ 体积上限 */

/** 条目视图最多渲染的行数；超出只计数，不把上千行一次铺进 DOM。 */
export const NATIVE_ENTRIES_MAX_ROWS = 500
/** 单条条目的预览字符上限（界面里更长的再省略一次）。 */
export const NATIVE_ENTRY_PREVIEW_MAX = 200
/** 单次最多扫描的原始条目数；异常大的返回不把主线程拖住。 */
export const NATIVE_ENTRIES_SCAN_MAX = 20_000

/* ------------------------------------------------------------------ 加载结果 */

export type NativeSurfaceLoad<T> = ({ ok: true } & T) | { ok: false; error: string }

export type NativeSurfaceActionResult =
  | { ok: true; message?: string; requiresReload?: boolean }
  /** `cancelled` 表示用户在主进程确认框里取消：是结果，不是错误。 */
  | { ok: false; error: string; cancelled?: boolean }

/* ------------------------------------------------------------------ 模型范围 */

export interface RawScopedModel {
  provider: string
  id: string
  name: string
}

export interface ScopedModelOption extends RawScopedModel {
  key: string
  /** 是否在当前 Ctrl+P 循环范围内。 */
  inScope: boolean
  /** 是否是当前会话正在使用的模型。 */
  current: boolean
}

export interface ScopedModelsView {
  models: ScopedModelOption[]
  /** pi 的 `enabledModels` 为空 = 全部可用。 */
  scopeIsAll: boolean
}

/** 后台返回的模型 + 选中键 → 渲染模型。空选中键表示「全部可用」，缺字段的条目丢弃。 */
export function buildScopedModelsView(
  models: readonly RawScopedModel[] | null | undefined,
  scopedModelIds: readonly string[] | null | undefined,
  current?: { provider: string; id: string } | null
): ScopedModelsView {
  const scopeIsAll = (scopedModelIds?.length ?? 0) === 0
  const selected = new Set(scopedModelIds ?? [])
  const seen = new Set<string>()
  const options: ScopedModelOption[] = []
  for (const model of models ?? []) {
    const provider = typeof model?.provider === 'string' ? model.provider : ''
    const id = typeof model?.id === 'string' ? model.id : ''
    if (!provider || !id) continue
    const key = nativeModelKey({ provider, id })
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      provider,
      id,
      name: typeof model.name === 'string' && model.name ? model.name : id,
      key,
      inScope: scopeIsAll || selected.has(key),
      current: !!current && current.provider === provider && current.id === id
    })
  }
  return { models: options, scopeIsAll }
}

/** 两组键是否相同（无序比较）。 */
export function sameKeySet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}

/**
 * 把草稿键转成写给 pi 的完整模型键列表。
 *
 * pi 的 `enabledModels` 为空 = 全部可用；因此显式全选写空数组而不是逐条 pattern，
 * 这样后续新增模型也会自动进入范围。空模型列表同样按空处理。
 */
export function scopeSaveIds(draft: ReadonlySet<string>, models: readonly ScopedModelOption[]): string[] {
  const all = models.map((model) => model.key)
  if (all.length > 0 && all.every((key) => draft.has(key))) return []
  return all.filter((key) => draft.has(key)).sort()
}

/** 草稿相对当前范围是否有变化。 */
export function isScopeDirty(draft: ReadonlySet<string>, baseline: ReadonlySet<string>): boolean {
  return !sameKeySet(draft, baseline)
}

/* ------------------------------------------------------------------ 项目信任 */

export interface TrustView {
  cwd: string
  trusted: boolean
  /** 让它是 `true` 的那条 trust 条目（向上命中的路径）；没有就是 null。 */
  entry: string | null
  /** 该目录是否含 pi 的受保护资源；没有时「信任」不改变行为。 */
  requiresTrust: boolean
}

/** 后台信任结果 → 渲染模型；缺字段按未信任、无条目处理。 */
export function buildTrustView(result: Pick<NativeSessionHostResult, 'cwd' | 'trusted' | 'trustEntry' | 'requiresTrust'>): TrustView {
  return {
    cwd: typeof result.cwd === 'string' ? result.cwd : '',
    trusted: result.trusted === true,
    entry: typeof result.trustEntry === 'string' && result.trustEntry ? result.trustEntry : null,
    requiresTrust: result.requiresTrust !== false
  }
}

/* ------------------------------------------------------------------ 原始条目 */

export interface NativeEntryRow {
  id: string
  parentId: string | null
  kind: NativeEntryKind
  /** 条目原始 `type`，用于悬停提示。 */
  entryType: string
  preview: string
  timestamp?: string
}

export interface EntriesView {
  rows: NativeEntryRow[]
  /** 扫描到的有效条目总数（可能大于渲染行数）。 */
  total: number
  /** 实际渲染的行数。 */
  shown: number
  /** 是否因为行数 / 扫描上限没有显示（或没有统计）全部条目。 */
  truncated: boolean
}

/**
 * 原始条目 → 只读行。
 *
 * 缺 `id` / 非对象一律丢弃，不猜 id；行数、预览长度与总扫描量都有限量，
 * 保护统计如实返回，界面据此说明「只显示前 N 条」。不改写任何条目内容。
 */
export function buildEntriesView(
  entries: unknown,
  options: { maxRows?: number; previewMax?: number; scanMax?: number } = {}
): EntriesView {
  const maxRows = options.maxRows ?? NATIVE_ENTRIES_MAX_ROWS
  const previewMax = options.previewMax ?? NATIVE_ENTRY_PREVIEW_MAX
  const scanMax = options.scanMax ?? NATIVE_ENTRIES_SCAN_MAX
  const list = Array.isArray(entries) ? entries : []
  const rows: NativeEntryRow[] = []
  let total = 0
  let scanned = 0
  for (const raw of list) {
    if (scanned >= scanMax) break
    scanned += 1
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id) continue
    total += 1
    if (rows.length >= maxRows) continue
    const description = describeEntry(record)
    const parentId = typeof record.parentId === 'string' && record.parentId ? record.parentId : null
    rows.push({
      id,
      parentId,
      kind: description.kind,
      entryType: description.entryType,
      preview: nativeOneLine(description.text, previewMax),
      ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {})
    })
  }
  return {
    rows,
    total,
    shown: rows.length,
    truncated: scanned < list.length || total > rows.length
  }
}

/* ------------------------------------------------------------------ 加载 / 动作 */

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

/** 取模型循环范围 + 当前会话模型；请求绑定 `expectedSessionId`。 */
export async function loadScopedModels(
  transport: NativeSurfaceTransport,
  expectedSessionId: string,
  fallbackError: string,
  current?: { provider: string; id: string } | null
): Promise<NativeSurfaceLoad<{ view: ScopedModelsView }>> {
  try {
    const result = await transport.request({ action: 'scoped-models', expectedSessionId })
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    return { ok: true, view: buildScopedModelsView(result.models, result.scopedModelIds, current) }
  } catch (error) {
    return { ok: false, error: messageOf(error, fallbackError) }
  }
}

/** 保存模型循环范围：只发 `set-scoped-models` 与完整键列表（空数组 = 全部）。 */
export async function saveScopedModels(
  transport: NativeSurfaceTransport,
  expectedSessionId: string,
  modelIds: readonly string[],
  fallbackError: string
): Promise<NativeSurfaceActionResult> {
  try {
    const result = await transport.request({ action: 'set-scoped-models', expectedSessionId, modelIds: [...modelIds] })
    if (!result.ok) {
      if (result.cancelled) return { ok: false, error: result.error || fallbackError, cancelled: true }
      return { ok: false, error: result.error || fallbackError }
    }
    return { ok: true, requiresReload: result.requiresReload === true }
  } catch (error) {
    return { ok: false, error: messageOf(error, fallbackError) }
  }
}

/** 取项目信任状态（真实 project / cwd）。只读，不改设置。 */
export async function loadTrust(
  transport: NativeSurfaceTransport,
  expectedSessionId: string,
  fallbackError: string
): Promise<NativeSurfaceLoad<{ view: TrustView }>> {
  try {
    const result = await transport.request({ action: 'trust', expectedSessionId })
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    return { ok: true, view: buildTrustView(result) }
  } catch (error) {
    return { ok: false, error: messageOf(error, fallbackError) }
  }
}

/**
 * 保存项目信任决定：只发 `set-trust`。
 *
 * 破坏性确认（以及撤销时重建实例）由主进程以 `purpose: 'approval'` 的桌面 host
 * 守卫负责；本模块不自己弹确认、不调用审批接口。`cancelled` 是用户取消，不是失败。
 */
export async function saveTrust(
  transport: NativeSurfaceTransport,
  expectedSessionId: string,
  trusted: boolean,
  fallbackError: string
): Promise<NativeSurfaceActionResult> {
  try {
    const result = await transport.request({ action: 'set-trust', expectedSessionId, trusted })
    if (!result.ok) {
      if (result.cancelled) return { ok: false, error: result.error || fallbackError, cancelled: true }
      return { ok: false, error: result.error || fallbackError }
    }
    return { ok: true, requiresReload: result.requiresReload === true }
  } catch (error) {
    return { ok: false, error: messageOf(error, fallbackError) }
  }
}

/** 取原始条目（只读）；不带游标，一次性取回后由 `buildEntriesView` 限量。 */
export async function loadEntries(
  transport: NativeSurfaceTransport,
  expectedSessionId: string,
  fallbackError: string,
  since?: string
): Promise<NativeSurfaceLoad<{ view: EntriesView }>> {
  try {
    const request: NativeSessionHostRequest = { action: 'entries', expectedSessionId }
    if (typeof since === 'string' && since) request.since = since
    const result = await transport.request(request)
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    return { ok: true, view: buildEntriesView(result.entries) }
  } catch (error) {
    return { ok: false, error: messageOf(error, fallbackError) }
  }
}

/* ------------------------------------------------------------------ 文案 */

export interface NativeSurfaceText {
  title: Record<NativeSurfaceMode, string>
  loading: string
  loadFailed: string
  retry: string
  close: string
  actionFailed: string
  cancelled: string
  requiresReload: string
  viewEntries: string
  back: string
  unknownTitle: string
  unknownMode: (mode: string) => string
  scope: {
    lead: string
    label: string
    count: (n: number) => string
    all: string
    current: string
    empty: string
    selectAll: string
    clear: string
    save: string
    saving: string
    saved: string
  }
  trust: {
    lead: string
    cwd: string
    state: string
    trusted: string
    untrusted: string
    entry: string
    notRequired: string
    risk: string
    save: string
    revoke: string
    saved: string
    revoked: string
  }
  entries: {
    lead: string
    count: (shown: number, total: number) => string
    empty: string
    limit: (shown: number, total: number) => string
    refresh: string
    noParent: string
  }
  kind: Record<NativeEntryKind, string>
}

const ZH: NativeSurfaceText = {
  title: {
    'scoped-models': '模型循环范围',
    trust: '项目信任',
    entries: '会话条目'
  },
  loading: '正在读取…',
  loadFailed: '读取失败。',
  retry: '重试',
  close: '关闭',
  actionFailed: '操作失败。',
  cancelled: '已取消。',
  requiresReload: '已保存；运行实例已重建，界面将按新设置刷新。',
  viewEntries: '查看原始条目（只读）',
  back: '返回',
  unknownTitle: '无法打开的原生面板',
  unknownMode: (mode) => `收到未知的面板请求「${mode}」；请更新版本后重试，或查看日志。`,
  scope: {
    lead: '选择 Ctrl+P 交互式切换时轮换的模型；没有勾选任何模型表示全部可用。',
    label: '可用模型',
    count: (n) => `已选 ${n} 个`,
    all: '当前没有限制范围：全部可用模型都会进入循环。',
    current: '当前',
    empty: '当前会话没有可用的模型列表。',
    selectAll: '全选',
    clear: '清空',
    save: '保存范围',
    saving: '保存中…',
    saved: '模型范围已保存。'
  },
  trust: {
    lead: '信任决定按项目目录保存；授予后 pi 才会加载该项目里的扩展、技能与设置。',
    cwd: '目录',
    state: '当前状态',
    trusted: '已信任',
    untrusted: '未信任',
    entry: '命中的信任条目',
    notRequired: '该目录不含 pi 的受保护资源；信任与否不改变当前行为。',
    risk: '项目级扩展可能执行代码。只信任你了解的项目。',
    save: '信任此项目',
    revoke: '取消信任',
    saved: '已信任该项目。',
    revoked: '已取消信任。'
  },
  entries: {
    lead: '当前会话的持久条目（只读投影，不改写会话文件）。',
    count: (shown, total) => `显示 ${shown} / ${total} 条`,
    empty: '这条会话还没有持久条目。',
    limit: (shown, total) => `为控制体积，只显示前 ${shown} 条（共 ${total} 条）。`,
    refresh: '重新读取',
    noParent: '根'
  },
  kind: {
    user: '用户',
    assistant: '助手',
    tool: '工具',
    system: '系统',
    summary: '压缩摘要',
    branch: '分支摘要',
    label: '书签',
    meta: '元信息',
    custom: '自定义',
    usage: '用量',
    unknown: '其它'
  }
}

const EN: NativeSurfaceText = {
  title: {
    'scoped-models': 'Model rotation scope',
    trust: 'Project trust',
    entries: 'Session entries'
  },
  loading: 'Loading…',
  loadFailed: 'Could not load.',
  retry: 'Retry',
  close: 'Close',
  actionFailed: 'The action failed.',
  cancelled: 'Cancelled.',
  requiresReload: 'Saved; the runtime was rebuilt and the UI will refresh with the new settings.',
  viewEntries: 'View raw entries (read-only)',
  back: 'Back',
  unknownTitle: 'Unrecognized native panel',
  unknownMode: (mode) => `Received an unknown panel request "${mode}"; update the app and try again, or check the logs.`,
  scope: {
    lead: 'Pick the models cycled by Ctrl+P; selecting none means all available models.',
    label: 'Available models',
    count: (n) => `${n} selected`,
    all: 'No scope limit: every available model is in the rotation.',
    current: 'Current',
    empty: 'This session has no available model list.',
    selectAll: 'Select all',
    clear: 'Clear',
    save: 'Save scope',
    saving: 'Saving…',
    saved: 'Model scope saved.'
  },
  trust: {
    lead: 'The trust decision is stored per project directory; pi only loads that project’s extensions, skills and settings after you trust it.',
    cwd: 'Directory',
    state: 'Current state',
    trusted: 'Trusted',
    untrusted: 'Not trusted',
    entry: 'Matching trust entry',
    notRequired: 'This directory has no protected pi resources; trust does not change current behavior.',
    risk: 'Project-level extensions can execute code. Only trust projects you understand.',
    save: 'Trust this project',
    revoke: 'Revoke trust',
    saved: 'Trusted this project.',
    revoked: 'Revoked trust.'
  },
  entries: {
    lead: 'Persisted entries of this session (read-only projection; the session file is never rewritten).',
    count: (shown, total) => `${shown} / ${total} shown`,
    empty: 'This session has no persisted entries yet.',
    limit: (shown, total) => `Only the first ${shown} of ${total} entries are shown to keep the view bounded.`,
    refresh: 'Reload',
    noParent: 'root'
  },
  kind: {
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
    system: 'System',
    summary: 'Compaction',
    branch: 'Branch summary',
    label: 'Bookmark',
    meta: 'Meta',
    custom: 'Custom',
    usage: 'Usage',
    unknown: 'Other'
  }
}

export function nativeSurfaceText(lang: Lang): NativeSurfaceText {
  return lang === 'en-US' ? EN : ZH
}
