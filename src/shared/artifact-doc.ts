/**
 * 可编辑成果（ArtifactDoc）—— 契约与纯逻辑（实施-25 P06a）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它与 `main/artifacts.ts` 不是一回事
 * ══════════════════════════════════════════════════════════════════
 * `artifacts.ts` 是「AI 文件产物仓」：模型产出的一张图 / 一个 PDF，
 * 复制到按会话隔离的目录、挂回某条消息，**只读**。
 * 这里要的是**可继续编辑的文档对象**：稳定 ID、标题、正文、来源引用、
 * 版本、所属空间与任务 —— 用户与 agent 都要改它，而且改动不能互相吞。
 *
 * ── 本片唯一的不变量（P06a 的出口）──
 * **用户改过的段落，被 agent 重写整篇时不丢。**
 *
 * 实现方式是「按段落操作」而不是「整篇覆盖」：
 *   · 文档正文化成段落（空行分隔）；
 *   · 每版记下 `userEditedParagraphs`（用户在这版里亲手改过的段）；
 *   · agent 提交整篇重写时，落在这些段上的**不同内容**会被保留（用当前版本），
 *     并把被保留的段落号回报给调用方；
 *   · agent 要改某一段时，走 `replace-paragraphs` 定向替换 —— 那是显式修改，
 *     允许覆盖（并清掉该段的「用户改过」标记）。
 *
 * 为什么要段落而不是行/字符 diff：段落是**作者的单位**。行级合并会把
 * 「用户调了标点」和「agent 重写整句」混为一谈，字符级更糟。
 */

import type { SourceReference } from './library'

export const ARTIFACT_KINDS = ['markdown', 'checklist'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** 成果里的一条来源引用：只存 `{ sourceId, version }`，与资料库同一口径。 */
export interface ArtifactSourceRef extends SourceReference {
  /** 引用到成果正文的哪个字符区间（可选，用于「回原文」与「哪段引了它」）。 */
  locator?: { start: number; end: number }
}

export interface ArtifactVersion {
  version: number
  text: string
  editedBy: 'user' | 'agent'
  at: number
  /** 这一版基于哪一版（第一版为 `null`）。 */
  basedOn: number | null
  /** 用户在这一版里亲手改过的段落序号（0 基）。agent 整篇重写要跳过它们。 */
  userEditedParagraphs: number[]
  note?: string
}

export interface ArtifactDoc {
  id: string
  spaceId?: string
  taskId?: string
  title: string
  kind: ArtifactKind
  /** 当前版本号（`versions` 里必然存在这一版）。 */
  currentVersion: number
  versions: ArtifactVersion[]
  /** 来源引用（版本无关的汇总；每条也带自己的版本）。 */
  sources: ArtifactSourceRef[]
  createdAt: number
  updatedAt: number
}

export interface ArtifactDocument {
  version: 1
  docs: ArtifactDoc[]
}

export const MAX_ARTIFACT_DOCS = 2000
export const MAX_ARTIFACT_TITLE = 200
export const MAX_ARTIFACT_TEXT = 400_000
/** 保留的版本数上限；超了丢最旧（当前版本永远在）。 */
export const MAX_ARTIFACT_VERSIONS = 200

/* ------------------------------------------------------------------ *
 * 段落：作者的单位
 * ------------------------------------------------------------------ */

/** 正文 → 段落（一个或多个空行分隔；`\r\n` 归一成 `\n`）。 */
export function splitParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.trim()) return []
  return normalized.split(/\n{2,}/)
}

/** 段落 → 正文（与 `splitParagraphs` 成对）。 */
export function joinParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.join('\n\n')
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

export function versionOf(doc: ArtifactDoc, version: number): ArtifactVersion | undefined {
  return doc.versions.find((v) => v.version === version)
}

export function currentVersionOf(doc: ArtifactDoc): ArtifactVersion | undefined {
  return versionOf(doc, doc.currentVersion)
}

export function currentTextOf(doc: ArtifactDoc): string {
  return currentVersionOf(doc)?.text ?? ''
}

/** 活动成果（不按空间过滤时返回全部），最近更新的在前。 */
export function activeArtifacts(docs: readonly ArtifactDoc[], spaceId?: string | null): ArtifactDoc[] {
  return docs
    .filter((d) => (spaceId === undefined ? true : (d.spaceId ?? null) === spaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/* ------------------------------------------------------------------ *
 * 校验与读盘容错
 * ------------------------------------------------------------------ */

export function validateArtifactTitle(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: '标题不能为空' }
  const title = raw.trim()
  if (title.length > MAX_ARTIFACT_TITLE) return { ok: false, reason: `标题最多 ${MAX_ARTIFACT_TITLE} 个字符` }
  if (/[\u0000-\u001f\u007f]/.test(title)) return { ok: false, reason: '标题含控制字符' }
  return { ok: true, value: title }
}

export function validateArtifactText(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: '正文不是文本' }
  if (raw.length > MAX_ARTIFACT_TEXT) return { ok: false, reason: `正文最多 ${MAX_ARTIFACT_TEXT} 个字符` }
  return { ok: true, value: raw }
}

function sanitizeSourceRef(raw: unknown): ArtifactSourceRef | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.sourceId !== 'string' || !o.sourceId.trim()) return null
  const version = Number(o.version)
  if (!Number.isFinite(version) || version < 1) return null
  const ref: ArtifactSourceRef = { sourceId: o.sourceId.trim(), version: Math.floor(version) }
  const loc = o.locator as { start?: unknown; end?: unknown } | undefined
  if (loc && Number.isFinite(loc.start) && Number.isFinite(loc.end)) {
    const start = Math.max(0, Math.floor(Number(loc.start)))
    const end = Math.max(start, Math.floor(Number(loc.end)))
    ref.locator = { start, end }
  }
  return ref
}

function sanitizeVersion(raw: unknown): ArtifactVersion | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const version = Number(o.version)
  if (!Number.isFinite(version) || version < 1) return null
  if (typeof o.text !== 'string') return null
  const editedBy = o.editedBy === 'user' ? 'user' : o.editedBy === 'agent' ? 'agent' : null
  if (!editedBy) return null
  const basedOnRaw = Number(o.basedOn)
  const userEditedParagraphs = Array.isArray(o.userEditedParagraphs)
    ? [...new Set(o.userEditedParagraphs.filter((n) => Number.isInteger(n) && n >= 0) as number[])].sort((a, b) => a - b)
    : []
  return {
    version: Math.floor(version),
    text: o.text.slice(0, MAX_ARTIFACT_TEXT),
    editedBy,
    at: Number.isFinite(o.at) ? Number(o.at) : Date.now(),
    basedOn: Number.isFinite(basedOnRaw) && basedOnRaw >= 1 ? Math.floor(basedOnRaw) : null,
    userEditedParagraphs,
    ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim().slice(0, 1000) } : {})
  }
}

function sanitizeDoc(raw: unknown): ArtifactDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  const titleCheck = validateArtifactTitle(o.title)
  if (!titleCheck.ok) return null
  const versions: ArtifactVersion[] = []
  const seen = new Set<number>()
  for (const item of Array.isArray(o.versions) ? o.versions : []) {
    const version = sanitizeVersion(item)
    if (!version || seen.has(version.version)) continue
    seen.add(version.version)
    versions.push(version)
  }
  if (!versions.length) return null
  versions.sort((a, b) => a.version - b.version)
  const requested = Number(o.currentVersion)
  const current = seen.has(requested) ? Math.floor(requested) : versions[versions.length - 1].version
  const sources: ArtifactSourceRef[] = []
  for (const item of Array.isArray(o.sources) ? o.sources : []) {
    const ref = sanitizeSourceRef(item)
    if (!ref || sources.some((s) => s.sourceId === ref.sourceId && s.version === ref.version)) continue
    sources.push(ref)
  }
  const createdAt = Number.isFinite(o.createdAt) ? Number(o.createdAt) : Date.now()
  return {
    id: o.id.trim().slice(0, 120),
    ...(typeof o.spaceId === 'string' && o.spaceId.trim() ? { spaceId: o.spaceId.trim().slice(0, 120) } : {}),
    ...(typeof o.taskId === 'string' && o.taskId.trim() ? { taskId: o.taskId.trim().slice(0, 120) } : {}),
    title: titleCheck.value,
    kind: (ARTIFACT_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as ArtifactKind) : 'markdown',
    currentVersion: current,
    versions: versions.slice(-MAX_ARTIFACT_VERSIONS),
    sources,
    createdAt,
    updatedAt: Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : createdAt
  }
}

/** 读盘容错：坏条目丢掉，不让一份坏文档拦住启动。 */
export function sanitizeArtifactDocument(raw: unknown): ArtifactDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<ArtifactDocument>) : {}
  const docs: ArtifactDoc[] = []
  for (const item of Array.isArray(source.docs) ? source.docs : []) {
    const doc = sanitizeDoc(item)
    if (doc && !docs.some((d) => d.id === doc.id)) docs.push(doc)
  }
  return { version: 1, docs: docs.slice(-MAX_ARTIFACT_DOCS) }
}

/* ------------------------------------------------------------------ *
 * 变更（纯函数）
 * ------------------------------------------------------------------ */

export function makeArtifactId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  for (let i = 0; i < 200; i++) {
    const id = `ad_${Math.floor(random() * 0xffffffff).toString(36)}${Date.now().toString(36).slice(-4)}`
    if (!taken(id)) return id
  }
  return `ad_${Date.now().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`
}

export interface CreateArtifactInput {
  title: string
  text?: string
  kind?: ArtifactKind
  spaceId?: string
  taskId?: string
}

export type ArtifactMutation =
  | { ok: true; doc: ArtifactDoc; unchanged?: boolean; preserved?: number[] }
  | { ok: false; reason: string }

/**
 * 建一份成果。
 *
 * 第一版标 `editedBy: 'user'`（新建的人就是用户），但 `userEditedParagraphs`
 * **为空** —— 初始内容不是「用户改过的段落」。这条区别很关键：若把初稿也算
 * 「用户改过」，agent 后续连一个字都改不了（每个段落都会被保护）。
 */
export function createArtifactDoc(
  input: CreateArtifactInput,
  at: number,
  makeId: (taken: (id: string) => boolean) => string
): ArtifactMutation {
  const title = validateArtifactTitle(input.title)
  if (!title.ok) return { ok: false, reason: title.reason }
  const text = validateArtifactText(input.text ?? '')
  if (!text.ok) return { ok: false, reason: text.reason }
  const kind = input.kind ?? 'markdown'
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `未知的成果类型：${String(kind)}` }
  const doc: ArtifactDoc = {
    id: makeId(() => false),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    title: title.value,
    kind,
    currentVersion: 1,
    versions: [
      {
        version: 1,
        text: text.value,
        editedBy: 'user',
        at,
        basedOn: null,
        userEditedParagraphs: []
      }
    ],
    sources: [],
    createdAt: at,
    updatedAt: at
  }
  return { ok: true, doc }
}

function appendVersion(doc: ArtifactDoc, version: ArtifactVersion): ArtifactDoc {
  const versions = [...doc.versions, version]
  const trimmed = versions.length > MAX_ARTIFACT_VERSIONS ? versions.slice(-MAX_ARTIFACT_VERSIONS) : versions
  return {
    ...doc,
    currentVersion: version.version,
    versions: trimmed,
    updatedAt: version.at
  }
}

/**
 * 用户保存编辑。
 *
 * 与当前正文相同 → **不开新版本**（只会在历史里堆一条没有意义的重复）。
 * 否则开一版 `editedBy: 'user'`。
 *
 * ── 哪些段落算「用户改过」（要被 agent 整篇重写保护）──
 * 只算**修改既有段落**：新版本里那些「上一版在同样位置已有内容、而内容不同」的段。
 * 用户在空文档里新写的段（或往后追加的段）算**扩展内容**，不算「改动」——
 * 否则一份用户从零写的文档会让 agent 连一个字都改不了（整篇重写全部被保护）。
 * agent 若要改这类内容，应走定向替换（`replace-paragraphs`）；
 * 而「用户在 agent 稿上改过的那一段」才是最需要保护的。
 */
export function applyUserEdit(doc: ArtifactDoc, nextText: unknown, at: number): ArtifactMutation {
  const text = validateArtifactText(nextText)
  if (!text.ok) return { ok: false, reason: text.reason }
  const current = currentVersionOf(doc)
  if (!current) return { ok: false, reason: '成果没有可用的当前版本' }
  if (text.value === current.text) return { ok: true, doc, unchanged: true }

  const prevParas = splitParagraphs(current.text)
  const nextParas = splitParagraphs(text.value)
  const changed: number[] = []
  for (let i = 0; i < prevParas.length; i++) {
    if ((prevParas[i] ?? '') !== (nextParas[i] ?? '')) changed.push(i)
  }
  const carried = current.userEditedParagraphs.filter((i) => i < nextParas.length)
  const userEditedParagraphs = [...new Set([...carried, ...changed])].sort((a, b) => a - b)

  return {
    ok: true,
    doc: appendVersion(doc, {
      version: doc.currentVersion + 1,
      text: text.value,
      editedBy: 'user',
      at,
      basedOn: doc.currentVersion,
      userEditedParagraphs
    })
  }
}

export interface AgentEditInput {
  /** 必须等于当前版本，否则 `stale`（别拿旧基线改新正文）。 */
  baseVersion: number
  mode: 'rewrite-all' | 'replace-paragraphs'
  /** `rewrite-all` 用：新的整篇正文。 */
  text?: string
  /** `replace-paragraphs` 用：要定向替换的段落（显式修改，允许覆盖用户改动）。 */
  paragraphs?: { index: number; text: string }[]
  note?: string
}

/**
 * agent 改正文。
 *
 * **这是「用户编辑不被覆盖」的落点**：
 *   · `rewrite-all`：逐段比对，凡是用户改过的段落（`userEditedParagraphs`）
 *     且新稿与当前不同 → 保留当前版本那一段，并把段落号记进 `preserved`。
 *   · `replace-paragraphs`：只改指定段落 —— 那是定向修改，允许覆盖，
 *     并从「用户改过」集合里移除该段（它的手写内容确实被替换了）。
 */
export function applyAgentEdit(doc: ArtifactDoc, input: AgentEditInput, at: number): ArtifactMutation {
  const current = currentVersionOf(doc)
  if (!current) return { ok: false, reason: '成果没有可用的当前版本' }
  if (!Number.isInteger(input?.baseVersion) || input.baseVersion !== doc.currentVersion) {
    return { ok: false, reason: `基线版本不是当前版本（收到 ${String(input?.baseVersion)}，当前 ${doc.currentVersion}）` }
  }

  const preserved: number[] = []
  let nextText: string
  let userEditedParagraphs = [...current.userEditedParagraphs]

  if (input.mode === 'rewrite-all') {
    const text = validateArtifactText(input.text ?? '')
    if (!text.ok) return { ok: false, reason: text.reason }
    const curParas = splitParagraphs(current.text)
    const nextParas = splitParagraphs(text.value)
    for (const index of current.userEditedParagraphs) {
      if (index >= curParas.length) continue
      if (index < nextParas.length && nextParas[index] !== curParas[index]) {
        nextParas[index] = curParas[index]
        preserved.push(index)
      }
    }
    preserved.sort((a, b) => a - b)
    nextText = joinParagraphs(nextParas)
  } else if (input.mode === 'replace-paragraphs') {
    const edits = Array.isArray(input.paragraphs) ? input.paragraphs : null
    if (!edits || edits.length === 0) return { ok: false, reason: '没有要替换的段落' }
    const paras = splitParagraphs(current.text)
    const touched: number[] = []
    for (const edit of edits) {
      if (!Number.isInteger(edit?.index) || edit.index < 0 || edit.index >= paras.length) {
        return { ok: false, reason: `段落序号越界：${String(edit?.index)}（当前共 ${paras.length} 段）` }
      }
      if (typeof edit.text !== 'string') return { ok: false, reason: '段落内容不是文本' }
      paras[edit.index] = edit.text
      touched.push(edit.index)
    }
    /* 定向替换是显式修改：被替换的段不再算「用户手写内容」 */
    userEditedParagraphs = userEditedParagraphs.filter((i) => !touched.includes(i))
    nextText = joinParagraphs(paras)
  } else {
    return { ok: false, reason: `未知的编辑方式：${String(input.mode)}` }
  }

  const text = validateArtifactText(nextText)
  if (!text.ok) return { ok: false, reason: text.reason }
  if (text.value === current.text) return { ok: true, doc, unchanged: true, preserved }

  return {
    ok: true,
    preserved,
    doc: appendVersion(doc, {
      version: doc.currentVersion + 1,
      text: text.value,
      editedBy: 'agent',
      at,
      basedOn: doc.currentVersion,
      userEditedParagraphs,
      ...(input.note ? { note: input.note.slice(0, 1000) } : {})
    })
  }
}

/** 改标题。 */
export function renameArtifact(doc: ArtifactDoc, title: unknown, at: number): ArtifactMutation {
  const check = validateArtifactTitle(title)
  if (!check.ok) return { ok: false, reason: check.reason }
  if (check.value === doc.title) return { ok: true, doc, unchanged: true }
  return { ok: true, doc: { ...doc, title: check.value, updatedAt: at } }
}

/** 归属空间 / 任务（`null` 显式清空）。 */
export function assignArtifact(
  doc: ArtifactDoc,
  patch: { spaceId?: string | null; taskId?: string | null },
  at: number
): ArtifactMutation {
  const next: ArtifactDoc = { ...doc, updatedAt: at }
  if (patch.spaceId !== undefined) {
    if (patch.spaceId === null) delete next.spaceId
    else next.spaceId = patch.spaceId.trim().slice(0, 120)
  }
  if (patch.taskId !== undefined) {
    if (patch.taskId === null) delete next.taskId
    else next.taskId = patch.taskId.trim().slice(0, 120)
  }
  return { ok: true, doc: next }
}

/** 加一条来源引用（按 `sourceId + version` 去重，幂等；可带定位区间）。 */
export function addArtifactSource(doc: ArtifactDoc, ref: ArtifactSourceRef, at: number): ArtifactMutation {
  const source = sanitizeSourceRef(ref)
  if (!source) return { ok: false, reason: '来源引用形状不合法' }
  if (doc.sources.some((s) => s.sourceId === source.sourceId && s.version === source.version)) {
    return { ok: true, doc, unchanged: true }
  }
  return { ok: true, doc: { ...doc, sources: [...doc.sources, source], updatedAt: at } }
}

/* ------------------------------------------------------------------ *
 * 结构化清单（T06b-1）：Markdown 复选框
 * ------------------------------------------------------------------ */

/**
 * 结构化清单以 **Markdown 任务列表**为正式编辑对象（`- [ ]` / `- [x]`）。
 *
 * 为什么不另建一套 items 数据模型：那会让版本、段落保护、导出、来源引用
 * 全部分叉成两套。清单的结构语义由这里的解析/勾选函数提供，存储仍是文本 ——
 * 清单与文档共用同一条版本链。
 */
const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s?(.*)$/

export interface ChecklistItem {
  text: string
  done: boolean
  /** 在原文里的行号（0 基），用于精确改回那一行。 */
  line: number
}

export function parseChecklist(text: string): ChecklistItem[] {
  const out: ChecklistItem[] = []
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      const m = CHECKBOX_RE.exec(line)
      if (m) out.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x', line: index })
    })
  return out
}

/** 把条目拼回 Markdown（与 `parseChecklist` 成对）。 */
export function checklistToText(items: readonly { text: string; done: boolean }[]): string {
  return items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`.trimEnd()).join('\n')
}

/** 勾选 / 取消勾选第 `index` 个条目（按行替换，保持其余内容一字不改）。 */
export function toggleChecklistItem(text: string, index: number): { ok: true; text: string } | { ok: false; reason: string } {
  const items = parseChecklist(text)
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    return { ok: false, reason: `清单项序号越界：${String(index)}（共 ${items.length} 项）` }
  }
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const target = items[index]
  lines[target.line] = lines[target.line].replace(/\[([ xX])\]/, (_all, mark: string) => (mark.toLowerCase() === 'x' ? '[ ]' : '[x]'))
  return { ok: true, text: lines.join('\n') }
}

export function isChecklistText(text: string): boolean {
  return parseChecklist(text).length > 0
}

/* ------------------------------------------------------------------ *
 * 导出（T06b-3）：第一版只做 Markdown
 * ------------------------------------------------------------------ */

export interface ArtifactExportSource {
  sourceId: string
  version: number
  /** 展示标题（宿主从资料库取；取不到时回落到 id）。 */
  title?: string
}

/**
 * 渲染导出的 Markdown。
 *
 * 只做 Markdown（设计稿：PDF / Office 深度编辑不作为第一版前置）。
 * 来源标题由调用方给：**成果只存 `{sourceId, version}`**，标题去资料库取，
 * 不在这里复制一份（否则资料改名后导出又对不上）。
 */
export function renderArtifactMarkdown(doc: ArtifactDoc, sources: readonly ArtifactExportSource[] = []): string {
  const lines = [`# ${doc.title}`, '', currentTextOf(doc), '']
  if (sources.length > 0) {
    lines.push('---', '', '## 来源', '')
    for (const source of sources) {
      lines.push(`- ${source.title?.trim() || source.sourceId}（${source.sourceId}@v${source.version}）`)
    }
  }
  return lines.join('\n')
}
