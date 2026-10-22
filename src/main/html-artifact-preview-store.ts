import { randomBytes } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { HTML_ARTIFACT_MAX_BYTES, HTML_ARTIFACT_SCHEME, HTML_ASSET_MAX_BYTES, HTML_INLINE_MAX_BYTES, htmlArtifactAsset, htmlArtifactToken, type HtmlArtifactPreviewResult } from '../shared/html-artifact-preview'

interface Snapshot {
  html: string
  dir?: string
  root?: string
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(resolve(root), resolve(target))
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export class HtmlArtifactPreviewStore {
  private readonly snapshots = new Map<string, Snapshot>()
  private pending = 0
  private epoch = 0

  constructor(private readonly root: string, private readonly limit = 16) {}

  async prepare(path: string, root = this.root): Promise<HtmlArtifactPreviewResult> {
    if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, error: 'outside' }
    if (!['.html', '.htm'].includes(extname(path).toLowerCase())) return { ok: false, error: 'type' }
    if (this.snapshots.size + this.pending >= this.limit) return { ok: false, error: 'busy' }
    const epoch = this.epoch
    this.pending++
    try {
      const [rootReal, target] = await Promise.all([realpath(root), realpath(path)])
      if (!inside(rootReal, target)) return { ok: false, error: 'outside' }
      const handle = await open(target, 'r')
      let html: string
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return { ok: false, error: 'type' }
        if (stat.size <= 0 || stat.size > HTML_ARTIFACT_MAX_BYTES) return { ok: false, error: 'size' }
        const buffer = Buffer.alloc(HTML_ARTIFACT_MAX_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        if (!length || length > HTML_ARTIFACT_MAX_BYTES) return { ok: false, error: 'size' }
        html = buffer.subarray(0, length).toString('utf8')
      } finally {
        await handle.close()
      }
      if (epoch !== this.epoch) return { ok: false, error: 'read' }
      const token = randomBytes(16).toString('hex')
      this.snapshots.set(token, { html, dir: dirname(target), root: rootReal })
      return { ok: true, url: `${HTML_ARTIFACT_SCHEME}://${token}/index.html` }
    } catch {
      return { ok: false, error: 'read' }
    } finally {
      this.pending--
    }
  }

  prepareInline(html: unknown): HtmlArtifactPreviewResult {
    if (typeof html !== 'string' || !html) return { ok: false, error: 'type' }
    if (Buffer.byteLength(html, 'utf8') > HTML_INLINE_MAX_BYTES) return { ok: false, error: 'size' }
    if (this.snapshots.size + this.pending >= this.limit) return { ok: false, error: 'busy' }
    const token = randomBytes(16).toString('hex')
    this.snapshots.set(token, { html })
    return { ok: true, url: `${HTML_ARTIFACT_SCHEME}://${token}/index.html` }
  }

  clear(): void {
    this.epoch++
    this.snapshots.clear()
  }

  read(url: string): string | null {
    const token = htmlArtifactToken(url)
    return token ? this.snapshots.get(token)?.html ?? null : null
  }

  async readAsset(url: string): Promise<{ body: Buffer; type: string } | null> {
    const asset = htmlArtifactAsset(url)
    const snapshot = asset ? this.snapshots.get(asset.token) : undefined
    if (!asset || !snapshot?.dir || !snapshot.root) return null
    try {
      const target = await realpath(resolve(snapshot.dir, asset.rel))
      if (!inside(snapshot.root, target)) return null
      const handle = await open(target, 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > HTML_ASSET_MAX_BYTES) return null
        const body = Buffer.alloc(stat.size)
        let length = 0
        while (length < body.length) {
          const { bytesRead } = await handle.read(body, length, body.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        return this.snapshots.get(asset.token) === snapshot ? { body: body.subarray(0, length), type: asset.type } : null
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  release(url: string): void {
    const token = htmlArtifactToken(url)
    if (token) this.snapshots.delete(token)
  }
}
