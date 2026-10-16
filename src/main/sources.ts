import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { YAN_DIR } from './paths'

export type SourceKind = 'image' | 'file' | 'web'

export interface SourceRef {
  sourceId: string
  sessionId: string
  kind: SourceKind
  title: string
  ref: string
  fingerprint: string
  origin: string
  addedAt: number
  available: boolean
  error?: string
}

let baseDir: string | null = null

export function configureSources(next: { dir: string }): void {
  baseDir = next.dir
}

export function sourcesDir(sessionId: string): string {
  const raw = String(sessionId ?? '')
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  if (!safe || safe === '.' || safe === '..') throw new Error('会话 id 不合法')
  return join(baseDir ?? YAN_DIR, 'sources', safe)
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

function imageExt(mimeType: string, name: string): string {
  const byMime = IMAGE_EXT[String(mimeType ?? '').toLowerCase()]
  if (byMime) return byMime
  const byName = extname(String(name ?? '')).toLowerCase()
  return byName && byName.length <= 5 ? byName : '.bin'
}

export function saveImage(params: {
  sessionId: string
  name: string
  mimeType: string
  base64: string
}): SourceRef | null {
  const encoded = String(params.base64 ?? '')
  if (encoded.length > MAX_IMAGE_BASE64) return null
  const data = Buffer.from(encoded, 'base64')
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return null
  const fingerprint = createHash('sha256').update(data).digest('hex').slice(0, 32)
  const dir = sourcesDir(params.sessionId)
  const file = join(dir, fingerprint + imageExt(params.mimeType, params.name))
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    let validExisting = false
    try {
      const existing = readFileSync(file)
      validExisting = existing.length === data.length && createHash('sha256').update(existing).digest('hex').slice(0, 32) === fingerprint
    } catch { }
    if (!validExisting) {
      const temp = join(dir, `.${fingerprint}.${randomUUID()}.part`)
      try {
        writeFileSync(temp, data, { flag: 'wx' })
        renameSync(temp, file)
      } finally {
        try { rmSync(temp, { force: true }) } catch { }
      }
    }
    return {
      sourceId: `image:${fingerprint}`,
      sessionId: params.sessionId,
      kind: 'image',
      title: String(params.name ?? '') || '图片',
      ref: file,
      fingerprint,
      origin: String(params.name ?? ''),
      addedAt: Date.now(),
      available: true
    }
  } catch {
    return null
  }
}

export function registerFile(params: { sessionId: string; path: string; name?: string }): SourceRef | null {
  const path = resolve(String(params.path ?? ''))
  if (!path) return null
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    const fingerprint = `${st.size}:${Math.round(st.mtimeMs)}`
    return {
      sourceId: `file:${createHash('sha256').update(`${path}|${fingerprint}`).digest('hex').slice(0, 24)}`,
      sessionId: params.sessionId,
      kind: 'file',
      title: String(params.name ?? '') || path.split(/[\\/]/).pop() || path,
      ref: path,
      fingerprint,
      origin: path,
      addedAt: Date.now(),
      available: true
    }
  } catch {
    return null
  }
}

function listImages(sessionId: string): SourceRef[] {
  const dir = sourcesDir(sessionId)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif|bmp|bin)$/i.test(f))
      .flatMap((f) => {
        const fingerprint = f.replace(/\.[^.]+$/, '')
        const file = join(dir, f)
        let st: ReturnType<typeof statSync>
        try { st = statSync(file) } catch { return [] }
        return [{
          sourceId: `image:${fingerprint}`,
          sessionId,
          kind: 'image' as const,
          title: `${fingerprint.slice(0, 8)}${extname(f)}`,
          ref: file,
          fingerprint,
          origin: '',
          addedAt: st.mtimeMs,
          available: true,
          size: st.size
        }]
      })
      .sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  }
}

export function verifyFiles(sessionId: string, entries: { path: string; name?: string; addedAt?: number }[]): SourceRef[] {
  return entries
    .map((e) => {
      const ref = registerFile({ sessionId, path: e.path, name: e.name })
      if (!ref) {
        return {
          sourceId: `file:${createHash('sha256').update(String(e.path)).digest('hex').slice(0, 24)}`,
          sessionId,
          kind: 'file' as const,
          title: String(e.name ?? '') || String(e.path).split(/[\\/]/).pop() || String(e.path),
          ref: String(e.path),
          fingerprint: '',
          origin: String(e.path),
          addedAt: e.addedAt ?? Date.now(),
          available: false,
          error: '文件不在了（被删除或改名）'
        }
      }
      return { ...ref, addedAt: e.addedAt ?? ref.addedAt }
    })
    .filter(Boolean) as SourceRef[]
}

export interface SourceListing {
  ok: boolean
  images: SourceRef[]
  imageCount: number
  dir: string
  links: SourceLink[]
  error?: string
}

export function listImagesForSession(sessionId: string): SourceListing {
  try {
    const images = listImages(sessionId)
    return { ok: true, images, imageCount: images.length, dir: sourcesDir(sessionId), links: listLinks(sessionId) }
  } catch (error) {
    return {
      ok: false,
      images: [],
      imageCount: 0,
      dir: sourcesDir(sessionId),
      links: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export interface SourceLink {
  sourceId: string
  messageId: string
  at: number
}

const LINKS_FILE = 'links.json'
const MAX_LINKS = 500

function linksFile(sessionId: string): string {
  return join(sourcesDir(sessionId), LINKS_FILE)
}

function readLinks(sessionId: string): SourceLink[] {
  try {
    const raw = readFileSync(linksFile(sessionId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is SourceLink =>
        !!x &&
        typeof (x as SourceLink).sourceId === 'string' &&
        typeof (x as SourceLink).messageId === 'string'
    )
  } catch {
    return []
  }
}

function safeSourceId(value: string): string | null {
  const raw = String(value ?? '')
  return /^(image|file|web):[A-Za-z0-9._-]{1,96}$/.test(raw) ? raw : null
}

function safeMessageId(value: string): string | null {
  const raw = String(value ?? '')
  return /^[A-Za-z0-9._:-]{1,160}$/.test(raw) ? raw : null
}

export function listLinks(sessionId: string): SourceLink[] {
  return readLinks(sessionId)
}

export function linkSources(params: {
  sessionId: string
  sourceIds: string[]
  messageId: string
}): { ok: boolean; added: number; skipped: number; error?: string } {
  const messageId = safeMessageId(params.messageId)
  if (!messageId) return { ok: false, added: 0, skipped: 0, error: '消息 id 形状不对' }
  const ids = [...new Set((params.sourceIds ?? []).map((x) => safeSourceId(String(x))))].filter(
    (x): x is string => !!x
  )
  const skipped = (params.sourceIds ?? []).length - ids.length
  if (ids.length === 0) return { ok: true, added: 0, skipped }

  const existing = readLinks(params.sessionId)
  const key = (x: { sourceId: string; messageId: string }): string => `${x.sourceId}\u0000${x.messageId}`
  const seen = new Set(existing.map(key))
  const now = Date.now()
  const fresh: SourceLink[] = []
  for (const sourceId of ids) {
    const item = { sourceId, messageId, at: now }
    if (seen.has(key(item))) continue
    seen.add(key(item))
    fresh.push(item)
  }
  if (fresh.length === 0) return { ok: true, added: 0, skipped }

  const next = [...existing, ...fresh].slice(-MAX_LINKS)
  try {
    const dir = sourcesDir(params.sessionId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(linksFile(params.sessionId), JSON.stringify(next, null, 2))
  } catch (error) {
    return { ok: false, added: 0, skipped, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, added: fresh.length, skipped }
}

export function removeImage(sessionId: string, sourceId: string): { ok: boolean; error?: string } {
  const dir = resolve(sourcesDir(sessionId))
  const fingerprint = String(sourceId ?? '').replace(/^image:/, '')
  if (!/^[a-f0-9]{8,64}$/i.test(fingerprint)) return { ok: false, error: '来源 id 形状不对' }
  let removed = false
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(fingerprint)) continue
      const full = resolve(join(dir, f))
      if (!full.startsWith(dir)) continue
      rmSync(full, { force: true })
      removed = true
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return removed ? { ok: true } : { ok: false, error: '没有这份副本' }
}

export function readImage(sessionId: string, sourceId: string): { ok: boolean; base64?: string; mime?: string; error?: string } {
  const dir = resolve(sourcesDir(sessionId))
  const fingerprint = String(sourceId ?? '').replace(/^image:/, '')
  if (!/^[a-f0-9]{8,64}$/i.test(fingerprint)) return { ok: false, error: '来源 id 形状不对' }
  try {
    const hit = readdirSync(dir).find((f) => f.startsWith(fingerprint))
    if (!hit) return { ok: false, error: '没有这份副本' }
    const full = resolve(join(dir, hit))
    if (!full.startsWith(dir)) return { ok: false, error: '路径越界' }
    const ext = extname(hit).toLowerCase()
    const mime =
      ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : 'application/octet-stream'
    return { ok: true, base64: readFileSync(full).toString('base64'), mime }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function dropSession(sessionId: string): void {
  try {
    const root = resolve(baseDir ?? YAN_DIR, 'sources')
    const target = resolve(sourcesDir(sessionId))
    const relative = target.slice(root.length).replace(/^[\\/]+/, '')
    if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${process.platform === 'win32' ? '\\\\' : '/'}`) || resolve(root, relative) !== target) return
    rmSync(target, { recursive: true, force: true })
  } catch {
  }
}
