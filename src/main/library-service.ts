/**
 * 资料库服务（实施-25 P03 / W3）：导入、解析调度、打开引用、原件校验。
 *
 * 它把三件事串起来，而这三件事的顺序不能颠倒：
 *   1. **先定版本**（`library-store.decideImport`）—— 内容变了就新建版本，
 *      旧版本一字不改。任何解析都发生在版本确定之后；
 *   2. **再解析**（`library-parser`）—— 解析结果写到 `library/text/<id>-<v>.txt`，
 *      并作为**版本的状态**记录，而不是版本的内容；
 *   3. **最后才是引用**（`owner`）—— 会话 / 课程 / 成果只登记 `{ sourceId, version }`。
 *
 * 所以「更新文件后旧报告的第 N 页仍打开旧版本」这件事在这里是**默认行为**：
 * 打开旧引用 → 查旧版本 → 读那一版解析出来的文本。
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
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

/** 全量 hash 的上限；更大的文件用「size + mtime + 头尾各 1MB」快速指纹。 */
export const FULL_HASH_LIMIT = 8 * 1024 * 1024
const HEAD_TAIL = 1024 * 1024

export interface LibraryImportRequest {
  kind: LibraryKind
  /** 打开引用：文件 = 绝对路径；网页 = URL；文本 = 内容 hash 引用 */
  ref: string
  title: string
  /** 内容身份（不传则按 kind + ref 推导） */
  identity?: string
  /** 内容指纹（不传则按文件内容 / 文本内容计算） */
  fingerprint?: string
  size?: number
  spaceId?: string
  /** 只读的文件字节（文本 / 图片）；文件类（file）不需要 */
  content?: string
  /** 直接给定解析结果（例如网页抓回来的 HTML） */
  parse?: ParseOutcome
  /** 导入后登记引用（会话 / 课程 / 成果） */
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

/** 相对路径必须落在 root 内 —— 文本路径是我们自己写的，读取也要守住这条。 */
export function resolveWithin(root: string, relative: string): string | null {
  const full = resolve(root, relative)
  const base = resolve(root)
  if (full !== base && !full.startsWith(base + (process.platform === 'win32' ? String.fromCharCode(92) : '/'))) return null
  return full
}

/** 内容指纹：小文件全量、大文件头尾抽样（并把 size/mtime 纳入，避免"同头尾不同中段"）。 */
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

/** 相对 YAN_DIR 的文本路径。 */
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

  /**
   * 导入一份资料（幂等）。
   *
   * 顺序即不变量：**先定版本 → 再解析 → 最后登记引用**。
   * 解析失败**不会**让导入失败 —— 资料已经进来了，状态如实写 `unsupported` / `failed`。
   */
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
      /* 网页：内容变了（抓到的 HTML 不同）就是新版本，否则同一版 */
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
      const outcome = request.parse ?? (await this.parseFor(request))
      parse = await this.applyParse(sourceId, version, outcome)
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

  /**
   * 落解析结果。
   *
   * 正文写到 `library/text/<id>-v<version>.txt`，**文件名带版本号**：
   * 新旧版本共用同一个文件就会互相覆盖，那等于把版本机制做废。
   */
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
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, outcome.text, 'utf8')
      parse.textPath = rel
      parse.chars = outcome.text.length
    } else if (outcome.status === 'ok') {
      parse.status = 'unsupported'
      parse.note = outcome.note || '没有提取到正文'
    }
    await this.store.setParse(sourceId, version, parse)
    return parse
  }

  /**
   * 打开一条引用。
   *
   * **只按 `sourceId + version` 查表**（T03-2）：不按标题、不按路径重新找文件。
   * 旧版本照样能读 —— 这正是「更新文件后旧报告仍打开旧版本」的实现。
   *
   * 取不到正文**不算失败**：`outcome` 会如实说明是「已移除」「原件不可用」
   * 还是「没有文本层」，调用方据此显示，而不是抛错。
   */
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
      /* 正文文件丢了：引用本身仍在（可能还能用原件打开），只是取不到正文 */
      return base
    }
  }

  /**
   * 复核原件可用性。
   *
   * 只查 `file:` 的版本 —— 网页 / 文本 / 图片的字节由我们或 URL 持有，
   * 没有「原件被移动」这回事。结果写回版本状态，引用不会静默消失。
   */
  async verifyAvailability(refs: SourceReference[]): Promise<{ checked: number; unavailable: number }> {
    const doc = this.store.document()
    const results: { sourceId: string; version: number; available: boolean }[] = []
    for (const ref of refs) {
      const version = versionByRef(doc, ref)
      if (!version || !version.identity.startsWith('file:')) continue
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

  /**
   * 接管一条旧的会话级 `SourceRef`（T03-3）。
   *
   * 不做一次性搬迁：**用到才建映射**。已经建过就直接返回原来那一版，
   * 所以老会话反复打开也不会每次多出一份资料。
   */
  async promoteLegacy(params: {
    sessionId: string
    legacyId: string
    kind: LibraryKind
    title: string
    ref: string
    spaceId?: string
  }): Promise<LibraryImportOutcome & { mapped?: boolean }> {
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
