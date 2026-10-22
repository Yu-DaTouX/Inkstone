import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile, copyFile, unlink } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { AssistantArtifact, UIMessage } from '../shared/ipc'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const SESSION_HEADER_BYTES = 8192
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const MANIFEST = 'manifest.json'

const dirLocks = new Map<string, Promise<void>>()
const resolvedDirs = new Map<string, string>()

type ArtifactManifestItem = { messageId: string; artifact: AssistantArtifact }

function safeFilename(raw: string, fallback = 'artifact'): string {
  const base = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  return (base || fallback).slice(0, 180)
}

export function legacySessionKey(sessionFile: string): string {
  return createHash('sha256').update(resolve(sessionFile)).digest('hex').slice(0, 32)
}

function sessionKeyOf(sessionId: string): string {
  return `s-${sessionId}`
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function lockKey(dir: string): string {
  const full = resolve(dir)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function withDirLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = lockKey(dir)
  const prev = dirLocks.get(key) ?? Promise.resolve()
  const next = prev.then(task, task)
  const tail = next.then(() => undefined, () => undefined)
  dirLocks.set(key, tail)
  void tail.then(() => {
    if (dirLocks.get(key) === tail) dirLocks.delete(key)
  })
  return next
}

export async function readSessionId(sessionFile: string): Promise<string | null> {
  let handle
  try {
    handle = await open(sessionFile, 'r')
    const buffer = Buffer.alloc(SESSION_HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const end = text.indexOf('\n')
    const header = JSON.parse((end < 0 ? text : text.slice(0, end)).trim()) as { type?: unknown; id?: unknown }
    return header.type === 'session' && typeof header.id === 'string' && SESSION_ID_PATTERN.test(header.id) ? header.id : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function sessionArtifactDir(rootDir: string, sessionId: string): string | null {
  return SESSION_ID_PATTERN.test(sessionId) ? join(rootDir, sessionKeyOf(sessionId)) : null
}

function isWithin(root: string, candidate: string): boolean {
  const r = resolve(root)
  const c = resolve(candidate)
  return c === r || c.startsWith(`${r}${sep}`)
}

function mediaTypeOf(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.avif': return 'image/avif'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.json': return 'application/json'
    case '.md': return 'text/markdown'
    case '.txt': return 'text/plain'
    case '.ts': return 'text/typescript'
    case '.tsx': return 'text/tsx'
    case '.js': return 'text/javascript'
    case '.jsx': return 'text/jsx'
    case '.css': return 'text/css'
    case '.htm':
    case '.html': return 'text/html'
    default: return 'application/octet-stream'
  }
}

function isOfficeMediaType(mediaType: string): boolean {
  return mediaType.startsWith('application/vnd.openxmlformats-officedocument.')
}

function kindOf(mediaType: string): AssistantArtifact['kind'] {
  if (mediaType === 'image/svg+xml') return 'svg'
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf' || isOfficeMediaType(mediaType)) return 'document'
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return 'code'
  return 'binary'
}

function isPreviewable(kind: AssistantArtifact['kind'], mediaType: string): boolean {
  if (kind === 'document') return mediaType === 'application/pdf' || isOfficeMediaType(mediaType)
  return kind === 'image' || kind === 'svg' || kind === 'code'
}

function sanitizeSvg(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|xlink:href)\s*=\s*(["'])\s*(?:https?:|data:|javascript:)[\s\S]*?\1/gi, '')
}

function normalizeBytes(name: string, bytes: Buffer): Buffer {
  if (bytes.length === 0) throw new Error('artifact_empty')
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('artifact_too_large')
  const normalized = mediaTypeOf(name) === 'image/svg+xml'
    ? Buffer.from(sanitizeSvg(bytes.toString('utf8')), 'utf8')
    : bytes
  if (normalized.length === 0) throw new Error('artifact_empty')
  return normalized
}

function isManifestItem(item: unknown): item is ArtifactManifestItem {
  const value = item as Partial<ArtifactManifestItem> | null
  return !!value && typeof value === 'object' && typeof value.messageId === 'string' && !!value.artifact && typeof value.artifact.path === 'string'
}

async function readManifestFile(file: string): Promise<ArtifactManifestItem[]> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw) || !raw.every(isManifestItem)) throw new Error('清单结构无效')
    return raw
  } catch (error) {
    await copyFile(file, `${file}.corrupt-${randomUUID()}.bak`).catch(() => undefined)
    throw new Error(`成果清单损坏，为保护已有记录已拒绝写入：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeManifestFile(dir: string, items: ArtifactManifestItem[]): Promise<void> {
  const target = join(dir, MANIFEST)
  const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, JSON.stringify(items, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function rebind(dir: string, item: ArtifactManifestItem): ArtifactManifestItem {
  const name = baseName(item.artifact.path)
  const path = join(dir, name && name !== '.' && name !== '..' ? name : '.missing')
  return path === item.artifact.path ? item : { ...item, artifact: { ...item.artifact, path } }
}

async function isUsableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function adoptLegacyDir(legacy: string, target: string): Promise<void> {
  let names: string[]
  try { names = await readdir(legacy) } catch { return }
  const legacyItems = await readManifestFile(join(legacy, MANIFEST))
  await mkdir(target, { recursive: true })
  for (const name of names) {
    if (name === MANIFEST || name.endsWith('.tmp')) continue
    const to = join(target, name)
    if (!(await exists(to))) await rename(join(legacy, name), to)
  }
  const current = await readManifestFile(join(target, MANIFEST))
  const known = new Set(current.map((item) => item.artifact.id))
  const merged = [...legacyItems.filter((item) => !known.has(item.artifact.id)), ...current]
  merged.sort((a, b) => (a.artifact.createdAt ?? 0) - (b.artifact.createdAt ?? 0))
  await writeManifestFile(target, merged.map((item) => rebind(target, item)))
  await unlink(join(legacy, MANIFEST)).catch(() => undefined)
  const rest = await readdir(legacy).catch(() => null)
  if (rest && rest.every((name) => name.endsWith('.tmp'))) await rm(legacy, { recursive: true, force: true }).catch(() => undefined)
}

function fileSourceId(cwd: string, source: string): string {
  const rel = relative(cwd, source).split(sep).join('/')
  return `file:${process.platform === 'win32' ? rel.toLowerCase() : rel}`
}

export interface ArtifactSaveInput {
  sessionFile: string
  messageId: string
  filename: string
  bytes: Buffer
  sourceId?: string
  sourcePath?: string
  provider?: string
  model?: string
  description?: string
}

export interface ArtifactAttachInput {
  sessionFile: string
  messageId: string
  cwd: string
  sourcePath: string
  description?: string
}

export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async sessionDir(sessionFile: string): Promise<string> {
    const cacheKey = `${lockKey(this.rootDir)}|${lockKey(sessionFile)}`
    const cached = resolvedDirs.get(cacheKey)
    if (cached) return cached
    const legacy = join(this.rootDir, legacySessionKey(sessionFile))
    const sessionId = await readSessionId(sessionFile)
    if (!sessionId) return legacy
    const dir = join(this.rootDir, sessionKeyOf(sessionId))
    await withDirLock(dir, () => adoptLegacyDir(legacy, dir))
    resolvedDirs.set(cacheKey, dir)
    return dir
  }

  async save(input: ArtifactSaveInput): Promise<AssistantArtifact> {
    const filename = safeFilename(input.filename)
    const bytes = normalizeBytes(filename, input.bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const mediaType = mediaTypeOf(filename)
    const kind = kindOf(mediaType)
    const id = `art-${randomUUID()}`
    const sourceId = input.sourceId ?? id
    const dir = await this.sessionDir(input.sessionFile)
    await mkdir(dir, { recursive: true })
    return withDirLock(dir, async () => {
      const root = await realpath(dir)
      const items = (await readManifestFile(join(root, MANIFEST))).map((item) => rebind(root, item))
      const repeat = items.find(
        (item) => item.messageId === input.messageId && item.artifact.sourceId === sourceId && item.artifact.sha256 === sha256
      )
      if (repeat && (await isUsableFile(repeat.artifact.path))) return repeat.artifact
      let path: string | null = null
      for (const item of items) {
        if (item.artifact.sha256 === sha256 && (await isUsableFile(item.artifact.path))) {
          path = item.artifact.path
          break
        }
      }
      if (!path) {
        path = join(root, `${id}-${filename}`)
        await writeFile(path, bytes, { flag: 'wx' })
      }
      const siblings = items.filter((item) => item.artifact.sourceId === sourceId)
      const latest = siblings.reduce<AssistantArtifact | null>(
        (best, item) => (!best || (item.artifact.version ?? 1) >= (best.version ?? 1) ? item.artifact : best),
        null
      )
      const version = !latest ? 1 : latest.sha256 === sha256 ? latest.version ?? 1 : (latest.version ?? 1) + 1
      const artifact: AssistantArtifact = {
        id,
        sourceId,
        version,
        sha256,
        filename,
        path,
        mediaType,
        kind,
        bytes: bytes.length,
        createdAt: Date.now(),
        previewable: isPreviewable(kind, mediaType),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.description ? { description: input.description } : {})
      }
      items.push({ messageId: input.messageId, artifact })
      await writeManifestFile(root, items)
      return artifact
    })
  }

  async attach(input: ArtifactAttachInput): Promise<AssistantArtifact> {
    const source = await realpath(resolve(input.cwd, input.sourcePath))
    const projectRoot = await realpath(resolve(input.cwd)).catch(() => resolve(input.cwd))
    if (!isWithin(projectRoot, source)) throw new Error('artifact_path_outside_project')
    const info = await stat(source)
    if (!info.isFile()) throw new Error('artifact_not_a_file')
    if (info.size === 0) throw new Error('artifact_empty')
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error('artifact_too_large')
    const filename = safeFilename(source.slice(source.lastIndexOf(sep) + 1))
    const bytes = await readFile(source)
    return this.save({
      sessionFile: input.sessionFile,
      messageId: input.messageId,
      filename,
      bytes,
      sourceId: fileSourceId(projectRoot, source),
      sourcePath: source,
      description: input.description
    })
  }

  async list(sessionFile: string): Promise<ArtifactManifestItem[]> {
    const dir = await this.sessionDir(sessionFile)
    return (await readManifestFile(join(dir, MANIFEST))).map((item) => rebind(dir, item))
  }

  async hydrateMessages(sessionFile: string, messages: UIMessage[]): Promise<UIMessage[]> {
    const items = await this.list(sessionFile)
    if (!items.length) return messages
    const available = await Promise.all(items.map((item) => item.artifact.bytes > 0 ? isUsableFile(item.artifact.path) : false))
    const byMessage = new Map<string, AssistantArtifact[]>()
    items.forEach((item, index) => {
      const artifact = available[index]
        ? item.artifact
        : { ...item.artifact, unavailable: true, error: item.artifact.error ?? '原始文件不可用，无法预览。' }
      const current = byMessage.get(item.messageId) ?? []
      if (!current.some((existing) => existing.id === artifact.id)) current.push(artifact)
      byMessage.set(item.messageId, current)
    })
    return messages.map((message) => {
      const artifacts = byMessage.get(message.id)
      if (!artifacts?.length) return message
      const existing = message.artifacts ?? []
      const merged = [...existing]
      for (const artifact of artifacts) if (!merged.some((item) => item.id === artifact.id)) merged.push(artifact)
      return merged.length === existing.length ? message : { ...message, artifacts: merged }
    })
  }

  async listAll(): Promise<Array<{ sessionKey: string; sessionId: string | null; items: ArtifactManifestItem[] }>> {
    let names: string[]
    try { names = await readdir(this.rootDir) } catch { return [] }
    const results = await Promise.all(names.map(async (name) => {
      const dir = join(this.rootDir, name)
      try {
        const items = (await readManifestFile(join(dir, MANIFEST))).map((item) => rebind(dir, item))
        return items.length ? { sessionKey: name, sessionId: name.startsWith('s-') ? name.slice(2) : null, items } : null
      } catch {
        return null
      }
    }))
    return results.filter((item): item is NonNullable<typeof item> => !!item)
  }
}

export { mediaTypeOf, kindOf, MAX_ARTIFACT_BYTES }
