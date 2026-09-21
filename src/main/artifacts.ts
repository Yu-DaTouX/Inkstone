/**
 * 砚 AI 文件产物仓。
 *
 * 模型可以提出路径，但不能把路径直接交给渲染端。这里负责：
 *   1. 只接收当前项目内的真实普通文件，或宿主刚生成的 bytes；
 *   2. 复制到按会话隔离的受控目录；
 *   3. 写入轻量 manifest，使会话重启后仍能把产物挂回原消息；
 *   4. 对 SVG 做最小安全清理，渲染端永远不执行 HTML/Markdown。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { AssistantArtifact } from '../shared/ipc'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const MAX_MANIFEST_ITEMS = 200

type ArtifactManifestItem = { messageId: string; artifact: AssistantArtifact }

function safeFilename(raw: string, fallback = 'artifact'): string {
  const base = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  return (base || fallback).slice(0, 180)
}

function safeSessionKey(sessionFile: string): string {
  return createHash('sha256').update(resolve(sessionFile)).digest('hex').slice(0, 32)
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
    case '.json': return 'application/json'
    case '.md': return 'text/markdown'
    case '.txt': return 'text/plain'
    case '.ts': return 'text/typescript'
    case '.tsx': return 'text/tsx'
    case '.js': return 'text/javascript'
    case '.jsx': return 'text/jsx'
    case '.css': return 'text/css'
    case '.html': return 'text/html'
    default: return 'application/octet-stream'
  }
}

function kindOf(mediaType: string): AssistantArtifact['kind'] {
  if (mediaType === 'image/svg+xml') return 'svg'
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'document'
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return 'code'
  return 'binary'
}

function isPreviewable(kind: AssistantArtifact['kind']): boolean {
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

export interface ArtifactSaveInput {
  sessionFile: string
  messageId: string
  filename: string
  bytes: Buffer
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

  private sessionDir(sessionFile: string): string {
    return join(this.rootDir, safeSessionKey(sessionFile))
  }

  private manifestPath(sessionFile: string): string {
    return join(this.sessionDir(sessionFile), 'manifest.json')
  }

  async save(input: ArtifactSaveInput): Promise<AssistantArtifact> {
    const filename = safeFilename(input.filename)
    const bytes = normalizeBytes(filename, input.bytes)
    const mediaType = mediaTypeOf(filename)
    const kind = kindOf(mediaType)
    const id = `art-${randomUUID()}`
    const dir = this.sessionDir(input.sessionFile)
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${id}-${filename}`)
    await writeFile(target, bytes, { flag: 'wx' })
    const artifact: AssistantArtifact = {
      id,
      sourceId: id,
      filename,
      path: target,
      mediaType,
      kind,
      bytes: bytes.length,
      createdAt: Date.now(),
      previewable: isPreviewable(kind),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.description ? { description: input.description } : {})
    }
    await this.append(input.sessionFile, input.messageId, artifact)
    return artifact
  }

  async attach(input: ArtifactAttachInput): Promise<AssistantArtifact> {
    const source = await realpath(resolve(input.cwd, input.sourcePath))
    const projectRoot = resolve(input.cwd)
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
      description: input.description
    })
  }

  async list(sessionFile: string): Promise<ArtifactManifestItem[]> {
    try {
      const raw = JSON.parse(await readFile(this.manifestPath(sessionFile), 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.filter((item): item is ArtifactManifestItem => {
        if (!item || typeof item !== 'object') return false
        const value = item as Partial<ArtifactManifestItem>
        return typeof value.messageId === 'string' && !!value.artifact && typeof value.artifact.path === 'string'
      })
    } catch {
      return []
    }
  }

  async append(sessionFile: string, messageId: string, artifact: AssistantArtifact): Promise<void> {
    const items = await this.list(sessionFile)
    items.push({ messageId, artifact })
    await mkdir(this.sessionDir(sessionFile), { recursive: true })
    await writeFile(this.manifestPath(sessionFile), JSON.stringify(items.slice(-MAX_MANIFEST_ITEMS), null, 2), 'utf8')
  }

  async hydrateMessages(sessionFile: string, messages: import('../shared/ipc').UIMessage[]): Promise<import('../shared/ipc').UIMessage[]> {
    const items = await this.list(sessionFile)
    if (!items.length) return messages
    const byMessage = new Map<string, AssistantArtifact[]>()
    for (const item of items) {
      if (!isWithin(this.sessionDir(sessionFile), item.artifact.path)) continue
      let available = item.artifact.bytes > 0
      if (available) {
        try {
          const info = await stat(item.artifact.path)
          available = info.isFile() && info.size > 0
        } catch {
          available = false
        }
      }
      /* manifest 是历史证据：即使文件后来被清理，也要让用户看到原来有过产物。 */
      const artifact = available
        ? item.artifact
        : {
            ...item.artifact,
            unavailable: true,
            error: item.artifact.error ?? '原始文件不可用，无法预览。'
          }
      const current = byMessage.get(item.messageId) ?? []
      if (!current.some((existing) => existing.id === artifact.id)) current.push(artifact)
      byMessage.set(item.messageId, current)
    }
    return messages.map((message) => {
      const artifacts = byMessage.get(message.id)
      if (!artifacts?.length) return message
      const existing = message.artifacts ?? []
      const merged = [...existing]
      for (const artifact of artifacts) if (!merged.some((item) => item.id === artifact.id)) merged.push(artifact)
      return merged.length === existing.length ? message : { ...message, artifacts: merged }
    })
  }
}

export { mediaTypeOf, kindOf, MAX_ARTIFACT_BYTES }
