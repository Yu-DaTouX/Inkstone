import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  contentIdentity,
  legacyMappingOf,
  refOutcome,
  versionByRef,
  type LibraryKind,
  type LibraryOwner,
  type LibraryParse,
  type LibrarySource,
  type LibraryVersion,
  type RefOutcome,
  type SourceReference
} from '../shared/library'
import { LibraryStore } from './library-store'
import { htmlParseOutcome, parseLibraryFile, type ParseOutcome } from './library-parser'
import { YAN_DIR } from './paths'

export const FULL_HASH_LIMIT = 8 * 1024 * 1024
const HEAD_TAIL = 1024 * 1024

export interface LibraryImportRequest {
  kind: LibraryKind
  ref: string
  title: string
  identity?: string
  fingerprint?: string
  size?: number
  spaceId?: string
  content?: string
  parse?: ParseOutcome
  owner?: LibraryOwner
  at?: number
}

export interface LibraryImportOutcome {
  ok: boolean
  error?: string
  decision?: 'unchanged' | 'new-version' | 'new-source'
  sourceId?: string
  version?: number
  source?: LibrarySource
  parse?: LibraryParse
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function resolveWithin(root: string, relative: string): string | null {
  const full = resolve(root, relative)
  const base = resolve(root)
  if (full !== base && !full.startsWith(base + (process.platform === 'win32' ? String.fromCharCode(92) : '/'))) return null
  return full
}

export async function fingerprintFile(filePath: string, size: number): Promise<string> {
  const hash = createHash('sha256')
  if (size <= FULL_HASH_LIMIT) {
    hash.update(await readFile(filePath))
    return hash.digest('hex').slice(0, 32)
  }
  const info = await stat(filePath)
  hash.update(`size:${size}`)
  hash.update(`mtime:${Math.floor(info.mtimeMs)}`)
  const handle = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(Math.min(HEAD_TAIL, size))
    await handle.read(head, 0, head.length, 0)
    hash.update(head)
    if (size > HEAD_TAIL * 2) {
      const tail = Buffer.alloc(HEAD_TAIL)
      await handle.read(tail, 0, tail.length, size - HEAD_TAIL)
      hash.update(tail)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex').slice(0, 32)
}

export function textRelPath(sourceId: string, version: number): string {
  return `library/text/${sourceId}-v${version}.txt`
}

export class LibraryService {
  private readonly root: string
  readonly store: LibraryStore

  constructor(options: { root?: string; store?: LibraryStore } = {}) {
    this.root = options.root ?? YAN_DIR
    this.store = options.store ?? new LibraryStore({ root: this.root })
  }

  async import(request: LibraryImportRequest): Promise<LibraryImportOutcome> {
    let fingerprint = request.fingerprint
    let size = request.size

    if (request.kind === 'file') {
      let info
      try {
        info = await stat(request.ref)
      } catch {
        return { ok: false, error: '找不到这个文件（可能已被移动或删除）' }
      }
      if (!info.isFile()) return { ok: false, error: '这不是一个文件' }
      size = info.size
      if (!fingerprint) {
        try {
          fingerprint = await fingerprintFile(request.ref, info.size)
        } catch (error) {
          return { ok: false, error: `读不到文件内容：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    } else if (request.kind === 'text' || request.kind === 'image') {
      const body = request.content ?? ''
      fingerprint = fingerprint ?? sha256(body)
      size = size ?? Buffer.byteLength(body)
    } else {
      fingerprint = fingerprint ?? sha256(request.content ?? request.ref)
    }

    if (!fingerprint) return { ok: false, error: '无法确定内容指纹' }
    const identity = request.identity ?? contentIdentity(request.kind, request.ref)

    const res = await this.store.importSource({
      kind: request.kind,
      identity,
      fingerprint,
      title: request.title,
      ref: request.ref,
      ...(size !== undefined ? { size } : {}),
      ...(request.spaceId ? { spaceId: request.spaceId } : {}),
      ...(request.at !== undefined ? { at: request.at } : {})
    })
    if (!res.ok || !res.sourceId || !res.version) return { ok: false, error: res.error ?? '导入失败' }
    const sourceId = res.sourceId
    const version = res.version

    const current = this.store.document().versions.find((v) => v.sourceId === sourceId && v.version === version)
    const needsParse = res.decision !== 'unchanged' || !current || current.parse.status === 'pending'
    let parse = current?.parse
    if (needsParse) {
      try {
        const outcome = request.parse ?? (await this.parseFor(request))
        parse = await this.applyParse(sourceId, version, outcome)
      } catch (error) {
        const failed: LibraryParse = {
          status: 'failed',
          note: `解析资料失败：${error instanceof Error ? error.message : String(error)}`,
          at: Date.now()
        }
        try {
          await this.store.setParse(sourceId, version, failed)
          parse = failed
        } catch (saveError) {
          return { ok: false, error: `解析失败且无法保存失败状态：${saveError instanceof Error ? saveError.message : String(saveError)}`, sourceId, version }
        }
      }
    }

    if (request.owner) await this.store.addRef(request.owner, { sourceId, version })

    return {
      ok: true,
      ...(res.decision ? { decision: res.decision } : {}),
      sourceId,
      version,
      ...(res.source ? { source: res.source } : {}),
      ...(parse ? { parse } : {})
    }
  }

  private async parseFor(request: LibraryImportRequest): Promise<ParseOutcome> {
    if (request.kind === 'file') return parseLibraryFile(request.ref, 'file')
    if (request.kind === 'web') {
      if (request.content) return htmlParseOutcome(request.content)
      return { status: 'pending', note: '还没有抓到网页内容；抓到后会自动提取正文' }
    }
    if (request.kind === 'text') {
      const body = request.content ?? ''
      if (!body.trim()) return { status: 'unsupported', note: '内容是空的' }
      return { status: 'ok', text: body, note: '正文即资料本身' }
    }
    return { status: 'unsupported', note: '图片作为附件保留；正文提取（OCR）尚未接入' }
  }

  private async applyParse(sourceId: string, version: number, outcome: ParseOutcome): Promise<LibraryParse> {
    const parse: LibraryParse = {
      status: outcome.status,
      ...(outcome.pages !== undefined ? { pages: outcome.pages } : {}),
      note: outcome.note,
      at: Date.now()
    }
    if (outcome.status === 'ok' && outcome.text && outcome.text.trim()) {
      const rel = textRelPath(sourceId, version)
      const full = join(this.root, rel)
      const temp = `${full}.${process.pid}.${Date.now()}.tmp`
      try {
        await mkdir(dirname(full), { recursive: true })
        await writeFile(temp, outcome.text, 'utf8')
        await rename(temp, full)
        parse.textPath = rel
        parse.chars = outcome.text.length
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        parse.status = 'failed'
        parse.note = `保存解析正文失败：${error instanceof Error ? error.message : String(error)}`
      }
    } else if (outcome.status === 'ok') {
      parse.status = 'unsupported'
      parse.note = outcome.note || '没有提取到正文'
    }
    await this.store.setParse(sourceId, version, parse)
    return parse
  }

  async openRef(
    ref: SourceReference,
    options: { maxChars?: number } = {}
  ): Promise<{
    outcome: RefOutcome
    version?: LibraryVersion
    source?: LibrarySource
    text?: string
    truncated?: boolean
  }> {
    await this.store.load()
    const doc = this.store.document()
    const outcome = refOutcome(doc, ref)
    const version = versionByRef(doc, ref)
    const source = doc.sources.find((s) => s.id === ref.sourceId)
    const base = { outcome, ...(version ? { version } : {}), ...(source ? { source } : {}) }
    if (!version?.parse.textPath || !version.available) return base

    const full = resolveWithin(this.root, version.parse.textPath)
    if (!full) return base
    try {
      const body = await readFile(full, 'utf8')
      const max = options.maxChars ?? 200_000
      if (body.length > max) return { ...base, text: body.slice(0, max), truncated: true }
      return { ...base, text: body }
    } catch {
      return base
    }
  }

  async verifyAvailability(refs: SourceReference[]): Promise<{ checked: number; unavailable: number }> {
    await this.store.load()
    const doc = this.store.document()
    const results: { sourceId: string; version: number; available: boolean }[] = []
    for (const ref of refs) {
      const version = versionByRef(doc, ref)
      if (!version || !version.ref || !version.identity.startsWith('file:')) continue
      let available = true
      try {
        const info = await stat(version.ref)
        available = info.isFile()
      } catch {
        available = false
      }
      results.push({ sourceId: ref.sourceId, version: ref.version, available })
    }
    if (!results.length) return { checked: 0, unavailable: 0 }
    await this.store.setAvailability(results)
    return { checked: results.length, unavailable: results.filter((r) => !r.available).length }
  }

  async promoteLegacy(params: {
    sessionId: string
    legacyId: string
    kind: LibraryKind
    title: string
    ref: string
    spaceId?: string
  }): Promise<LibraryImportOutcome & { mapped?: boolean }> {
    await this.store.load()
    const existing = legacyMappingOf(this.store.document(), params.legacyId, params.sessionId)
    if (existing) {
      return { ok: true, decision: 'unchanged', sourceId: existing.sourceId, version: existing.version, mapped: true }
    }
    const res = await this.import({
      kind: params.kind,
      ref: params.ref,
      title: params.title,
      ...(params.spaceId ? { spaceId: params.spaceId } : {})
    })
    if (res.ok && res.sourceId && res.version) {
      await this.store.mapLegacy({
        legacyId: params.legacyId,
        sessionId: params.sessionId,
        sourceId: res.sourceId,
        version: res.version
      })
      return { ...res, mapped: true }
    }
    return res
  }
}
