import { parsePersistedDocument } from './persisted-document'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { writeFileDurable } from './write-file-durable'
import { dirname, join } from 'node:path'
import {
  EMPTY_LIBRARY,
  MAX_LIBRARY_SOURCES,
  MAX_NOTE,
  MAX_TITLE,
  decideImport,
  sameOwner,
  type LibraryDocument,
  type LibraryImportInput,
  type LibraryKind,
  type LibraryOwner,
  type LibraryParse,
  type LibraryParseStatus,
  type LibrarySource,
  type LibraryVersion,
  type LegacySourceMap,
  type SourceReference
} from '../shared/library'
import { YAN_DIR } from './paths'

export const LIBRARY_FILE_NAME = 'library.json'

export function libraryDocumentPath(root: string = YAN_DIR): string {
  return join(root, LIBRARY_FILE_NAME)
}

const KINDS: LibraryKind[] = ['file', 'web', 'text', 'image']
const PARSE_STATUSES: LibraryParseStatus[] = ['pending', 'ok', 'unsupported', 'failed']
const OWNER_KINDS = ['session', 'course', 'artifact']

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) return trimmed.slice(0, max)
  return trimmed
}

function num(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined
}

function sanitizeParse(raw: unknown, fallbackAt: number): LibraryParse {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const status = PARSE_STATUSES.includes(o.status as LibraryParseStatus)
    ? (o.status as LibraryParseStatus)
    : 'pending'
  return {
    status,
    ...(typeof o.textPath === 'string' && o.textPath.trim() ? { textPath: o.textPath.trim() } : {}),
    ...(num(o.chars) !== undefined ? { chars: num(o.chars) } : {}),
    ...(num(o.pages) !== undefined ? { pages: num(o.pages) } : {}),
    note: typeof o.note === 'string' ? o.note.slice(0, MAX_NOTE) : '',
    at: num(o.at) ?? fallbackAt
  }
}

function sanitizeSource(raw: unknown): LibrarySource | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const id = text(o.id, 80)
  const title = text(o.title, MAX_TITLE)
  if (!id || !title) return null
  if (!KINDS.includes(o.kind as LibraryKind)) return null
  const createdAt = num(o.createdAt) ?? Date.now()
  return {
    id,
    ...(text(o.spaceId, 80) ? { spaceId: text(o.spaceId, 80) as string } : {}),
    kind: o.kind as LibraryKind,
    title,
    createdAt,
    updatedAt: num(o.updatedAt) ?? createdAt,
    ...(num(o.removedAt) !== undefined ? { removedAt: num(o.removedAt) } : {}),
    ...(num(o.unavailableAt) !== undefined ? { unavailableAt: num(o.unavailableAt) } : {})
  }
}

function sanitizeVersion(raw: unknown, sourceIds: Set<string>): LibraryVersion | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const sourceId = text(o.sourceId, 80)
  const version = num(o.version)
  const identity = text(o.identity, 500)
  const ref = text(o.ref, 4000)
  const fingerprint = text(o.fingerprint, 200)
  const title = text(o.title, MAX_TITLE)
  if (!sourceId || !sourceIds.has(sourceId)) return null
  if (!version || version < 1) return null
  if (!identity || !ref || !fingerprint || !title) return null
  const addedAt = num(o.addedAt) ?? Date.now()
  return {
    sourceId,
    version: Math.floor(version),
    identity,
    ref,
    title,
    ...(num(o.size) !== undefined ? { size: num(o.size) } : {}),
    fingerprint,
    addedAt,
    available: o.available !== false,
    ...(num(o.checkedAt) !== undefined ? { checkedAt: num(o.checkedAt) } : {}),
    parse: sanitizeParse(o.parse, addedAt)
  }
}

export function sanitizeLibraryDocument(raw: unknown): LibraryDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<LibraryDocument>) : {}

  const sources: LibrarySource[] = []
  const seenSources = new Set<string>()
  for (const item of Array.isArray(source.sources) ? source.sources : []) {
    const parsed = sanitizeSource(item)
    if (!parsed || seenSources.has(parsed.id)) continue
    seenSources.add(parsed.id)
    sources.push(parsed)
  }

  const versions: LibraryVersion[] = []
  const seenVersions = new Set<string>()
  for (const item of Array.isArray(source.versions) ? source.versions : []) {
    const parsed = sanitizeVersion(item, seenSources)
    if (!parsed) continue
    const key = `${parsed.sourceId}@${parsed.version}`
    if (seenVersions.has(key)) continue
    seenVersions.add(key)
    versions.push(parsed)
  }

  const refs: LibraryDocument['refs'] = []
  const seenRefs = new Set<string>()
  for (const item of Array.isArray(source.refs) ? source.refs : []) {
    const o = item && typeof item === 'object' ? (item as unknown as Record<string, unknown>) : {}
    const ownerRaw = o.owner && typeof o.owner === 'object' ? (o.owner as Record<string, unknown>) : {}
    const refRaw = o.ref && typeof o.ref === 'object' ? (o.ref as Record<string, unknown>) : {}
    const ownerKind = OWNER_KINDS.includes(ownerRaw.kind as string) ? (ownerRaw.kind as LibraryOwner['kind']) : null
    const ownerId = text(ownerRaw.id, 200)
    const sourceId = text(refRaw.sourceId, 80)
    const version = num(refRaw.version)
    if (!ownerKind || !ownerId || !sourceId || !version || version < 1) continue
    const key = `${ownerKind}:${ownerId}|${sourceId}@${version}`
    if (seenRefs.has(key)) continue
    seenRefs.add(key)
    refs.push({
      owner: { kind: ownerKind, id: ownerId },
      ref: { sourceId, version: Math.floor(version) },
      at: num(o.at) ?? Date.now()
    })
  }

  const legacy: LegacySourceMap[] = []
  const seenLegacy = new Set<string>()
  for (const item of Array.isArray(source.legacy) ? source.legacy : []) {
    const o = item && typeof item === 'object' ? (item as unknown as Record<string, unknown>) : {}
    const legacyId = text(o.legacyId, 200)
    const sessionId = text(o.sessionId, 200)
    const sourceId = text(o.sourceId, 80)
    const version = num(o.version)
    if (!legacyId || !sessionId || !sourceId || !version || version < 1) continue
    const key = `${legacyId}|${sessionId}`
    if (seenLegacy.has(key)) continue
    seenLegacy.add(key)
    legacy.push({ legacyId, sessionId, sourceId, version: Math.floor(version), at: num(o.at) ?? Date.now() })
  }

  return { version: 1, sources: sources.slice(-MAX_LIBRARY_SOURCES), versions, refs, legacy }
}

export interface LibraryImportResult {
  ok: boolean
  error?: string
  decision?: 'unchanged' | 'new-version' | 'new-source'
  sourceId?: string
  version?: number
  source?: LibrarySource
}

function makeLibraryId(taken: (id: string) => boolean, random: () => number): string {
  for (let i = 0; i < 200; i++) {
    const id = `lib_${Math.floor(random() * 0xffffffff).toString(36)}${Date.now().toString(36).slice(-4)}`
    if (!taken(id)) return id
  }
  return `lib_${Date.now().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`
}

export class LibraryStore {
  private readonly root: string
  private readonly now: () => number
  private readonly random: () => number
  private doc: LibraryDocument = EMPTY_LIBRARY
  private loadPromise: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number; random?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const parsed = parsePersistedDocument(await readFile(libraryDocumentPath(this.root), 'utf8'), { sources: 'array', versions: 'array', refs: 'array', legacy: 'array' })
          const count = (parsed.sources as unknown[]).length
          if (count > MAX_LIBRARY_SOURCES) throw new Error(`资料库包含 ${count} 份资料，超过上限 ${MAX_LIBRARY_SOURCES}；拒绝静默丢弃旧资料`)
          this.doc = sanitizeLibraryDocument(parsed)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.doc = EMPTY_LIBRARY
            return
          }
          throw new Error('资料库文件读取或解析失败，已拒绝覆盖', { cause: error })
        }
      })()
    }
    return this.loadPromise
  }

  document(): LibraryDocument {
    return {
      version: 1,
      sources: [...this.doc.sources],
      versions: [...this.doc.versions],
      refs: [...this.doc.refs],
      legacy: [...this.doc.legacy]
    }
  }

  async importSource(input: LibraryImportInput): Promise<LibraryImportResult> {
    return this.enqueue(async () => {
      await this.load()
      const at = input.at ?? this.now()
      const decision = decideImport(this.doc, input)
      if (decision.kind === 'rejected') return { ok: false, error: decision.reason }

      if (decision.kind === 'unchanged') {
        const ref: SourceReference = { sourceId: decision.sourceId, version: decision.version }
        const current = this.doc.sources.find((s) => s.id === decision.sourceId)
        if (current?.removedAt !== undefined) {
          const stamp = this.now()
          const revived = { ...current, updatedAt: stamp }
          delete revived.removedAt
          this.doc = { ...this.doc, sources: this.doc.sources.map((s) => (s.id === current.id ? revived : s)) }
          await this.flush()
          return { ok: true, decision: 'unchanged', ...ref, source: revived }
        }
        return { ok: true, decision: 'unchanged', ...ref, ...(current ? { source: current } : {}) }
      }

      const parse: LibraryParse = { status: 'pending', note: '', at }
      const version: LibraryVersion = {
        sourceId: '',
        version: decision.version,
        identity: input.identity,
        ref: input.ref,
        title: input.title,
        ...(input.size !== undefined ? { size: input.size } : {}),
        fingerprint: input.fingerprint,
        addedAt: at,
        available: true,
        parse
      }

      if (decision.kind === 'new-version') {
        const next: LibraryVersion = { ...version, sourceId: decision.sourceId }
        this.doc = {
          ...this.doc,
          versions: [...this.doc.versions, next],
          sources: this.doc.sources.map((s) =>
            s.id === decision.sourceId
              ? {
                  ...s,
                  ...(s.removedAt !== undefined ? { removedAt: undefined } : {}),
                  updatedAt: at
                }
              : s
          )
        }
        await this.flush()
        return { ok: true, decision: 'new-version', sourceId: decision.sourceId, version: next.version, source: this.doc.sources.find((s) => s.id === decision.sourceId) }
      }

      const id = makeLibraryId((candidate) => this.doc.sources.some((s) => s.id === candidate), this.random)
      const source: LibrarySource = {
        id,
        ...(input.spaceId ? { spaceId: input.spaceId } : {}),
        kind: input.kind,
        title: input.title,
        createdAt: at,
        updatedAt: at
      }
      this.doc = {
        ...this.doc,
        sources: [...this.doc.sources, source],
        versions: [...this.doc.versions, { ...version, sourceId: id }]
      }
      await this.flush()
      return { ok: true, decision: 'new-source', sourceId: id, version: 1, source }
    })
  }

  async setParse(sourceId: string, version: number, parse: LibraryParse): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      let touched = false
      this.doc = {
        ...this.doc,
        versions: this.doc.versions.map((v) => {
          if (v.sourceId !== sourceId || v.version !== version) return v
          touched = true
          return { ...v, parse }
        })
      }
      if (!touched) return false
      await this.flush()
      return true
    })
  }

  async setAvailability(
    results: { sourceId: string; version: number; available: boolean }[],
    at?: number
  ): Promise<number> {
    return this.enqueue(async () => {
      await this.load()
      const stamp = at ?? this.now()
      const byKey = new Map(results.map((r) => [`${r.sourceId}@${r.version}`, r.available]))
      let changed = 0
      const versions = this.doc.versions.map((v) => {
        const key = `${v.sourceId}@${v.version}`
        if (!byKey.has(key)) return v
        const available = byKey.get(key) as boolean
        if (v.available === available && v.checkedAt !== undefined) return v
        changed += 1
        return { ...v, available, checkedAt: stamp }
      })
      if (!changed) return 0
      const unavailable = new Set(results.filter((r) => !r.available).map((r) => r.sourceId))
      const availableAgain = new Set(results.filter((r) => r.available).map((r) => r.sourceId))
      this.doc = {
        ...this.doc,
        versions,
        sources: this.doc.sources.map((s) => {
          if (!unavailable.has(s.id) && !availableAgain.has(s.id)) return s
          if (availableAgain.has(s.id)) {
            const next = { ...s }
            delete next.unavailableAt
            return next
          }
          return { ...s, unavailableAt: s.unavailableAt ?? stamp }
        })
      }
      await this.flush()
      return changed
    })
  }

  async attachToSpace(sourceId: string, spaceId: string | null): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      let touched = false
      this.doc = {
        ...this.doc,
        sources: this.doc.sources.map((s) => {
          if (s.id !== sourceId) return s
          touched = true
          return { ...s, spaceId: spaceId ?? undefined, updatedAt: this.now() }
        })
      }
      if (!touched) return false
      await this.flush()
      return true
    })
  }

  async renameSource(sourceId: string, title: string): Promise<{ ok: boolean; error?: string; source?: LibrarySource }> {
    return this.enqueue(async () => {
      await this.load()
      const clean = text(title, MAX_TITLE)
      if (!clean) return { ok: false, error: '标题不能为空' }
      const index = this.doc.sources.findIndex((s) => s.id === sourceId)
      if (index < 0) return { ok: false, error: '资料不存在' }
      const next: LibrarySource = { ...this.doc.sources[index], title: clean, updatedAt: this.now() }
      const sources = [...this.doc.sources]
      sources[index] = next
      this.doc = { ...this.doc, sources }
      await this.flush()
      return { ok: true, source: next }
    })
  }

  async removeSource(sourceId: string, at?: number): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      let touched = false
      const stamp = at ?? this.now()
      this.doc = {
        ...this.doc,
        sources: this.doc.sources.map((s) => {
          if (s.id !== sourceId) return s
          touched = true
          return { ...s, removedAt: s.removedAt ?? stamp, updatedAt: stamp }
        })
      }
      if (!touched) return false
      await this.flush()
      return true
    })
  }

  async restoreSource(sourceId: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      let touched = false
      this.doc = {
        ...this.doc,
        sources: this.doc.sources.map((s) => {
          if (s.id !== sourceId || s.removedAt === undefined) return s
          touched = true
          const next = { ...s, updatedAt: this.now() }
          delete next.removedAt
          return next
        })
      }
      if (!touched) return false
      await this.flush()
      return true
    })
  }

  async addRef(owner: LibraryOwner, ref: SourceReference): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      if (this.doc.refs.some((r) => sameOwner(r.owner, owner) && r.ref.sourceId === ref.sourceId && r.ref.version === ref.version)) {
        return false
      }
      this.doc = { ...this.doc, refs: [...this.doc.refs, { owner, ref, at: this.now() }] }
      await this.flush()
      return true
    })
  }

  async removeRef(owner: LibraryOwner, ref: SourceReference): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      const refs = this.doc.refs.filter(
        (r) => !(sameOwner(r.owner, owner) && r.ref.sourceId === ref.sourceId && r.ref.version === ref.version)
      )
      if (refs.length === this.doc.refs.length) return false
      this.doc = { ...this.doc, refs }
      await this.flush()
      return true
    })
  }

  async mapLegacy(params: {
    legacyId: string
    sessionId: string
    sourceId: string
    version: number
  }): Promise<LegacySourceMap | null> {
    return this.enqueue(async () => {
      await this.load()
      const existing = this.doc.legacy.find((l) => l.legacyId === params.legacyId && l.sessionId === params.sessionId)
      if (existing) return existing
      if (!this.doc.sources.some((s) => s.id === params.sourceId)) return null
      const entry: LegacySourceMap = { ...params, at: this.now() }
      this.doc = { ...this.doc, legacy: [...this.doc.legacy, entry] }
      await this.flush()
      return entry
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      await this.load()
      const previous = structuredClone(this.doc)
      try { return await job() } catch (error) { this.doc = previous; throw error }
    }
    const run = this.tail.then(guarded, guarded)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async flush(): Promise<void> {
    const target = libraryDocumentPath(this.root)
    const temp = `${target}.${process.pid}.tmp`
    try {
      await mkdir(dirname(target), { recursive: true })
      const payload = JSON.stringify(this.doc, null, 2)
      await writeFileDurable(temp, payload)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
