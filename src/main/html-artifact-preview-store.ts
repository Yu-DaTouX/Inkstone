import { randomBytes } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { HTML_ARTIFACT_MAX_BYTES, HTML_ARTIFACT_SCHEME, HTML_INLINE_MAX_BYTES, htmlArtifactToken, type HtmlArtifactPreviewResult } from '../shared/html-artifact-preview'

/** 活跃 iframe 持有只读快照，卸载即释放；不让协议 URL 直接解析任意磁盘路径。 */
export class HtmlArtifactPreviewStore {
  private readonly snapshots = new Map<string, string>()
  private pending = 0
  private epoch = 0

  constructor(private readonly root: string, private readonly limit = 16) {}

  async prepare(path: string): Promise<HtmlArtifactPreviewResult> {
    if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, error: 'outside' }
    if (!['.html', '.htm'].includes(extname(path).toLowerCase())) return { ok: false, error: 'type' }
    if (this.snapshots.size + this.pending >= this.limit) return { ok: false, error: 'busy' }
    const epoch = this.epoch
    this.pending++
    try {
      const [root, target] = await Promise.all([realpath(this.root), realpath(path)])
      const rel = relative(resolve(root), resolve(target))
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ok: false, error: 'outside' }
      const handle = await open(target, 'r')
      let html: string
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return { ok: false, error: 'type' }
        if (stat.size <= 0 || stat.size > HTML_ARTIFACT_MAX_BYTES) return { ok: false, error: 'size' }
        // 限长读取也约束 stat 之后文件继续增长的情况，不将残缺 HTML 交给 iframe。
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
      // 主窗口重载或退出后，旧读取不能再登记一个无人释放的快照。
      if (epoch !== this.epoch) return { ok: false, error: 'read' }
      const token = randomBytes(16).toString('hex')
      this.snapshots.set(token, html)
      return { ok: true, url: `${HTML_ARTIFACT_SCHEME}://${token}/index.html` }
    } catch {
      return { ok: false, error: 'read' }
    } finally {
      this.pending--
    }
  }

  /**
   * 消息内小部件：渲染端拼好的整页 HTML（模型写的片段 + 主题变量 + 高度/追问桥），
   * 与成果文件共用同一个隔离协议、CSP 与并发上限；内容只在内存里，卸载即释放。
   */
  prepareInline(html: unknown): HtmlArtifactPreviewResult {
    if (typeof html !== 'string' || !html) return { ok: false, error: 'type' }
    if (Buffer.byteLength(html, 'utf8') > HTML_INLINE_MAX_BYTES) return { ok: false, error: 'size' }
    if (this.snapshots.size + this.pending >= this.limit) return { ok: false, error: 'busy' }
    const token = randomBytes(16).toString('hex')
    this.snapshots.set(token, html)
    return { ok: true, url: `${HTML_ARTIFACT_SCHEME}://${token}/index.html` }
  }

  clear(): void {
    this.epoch++
    this.snapshots.clear()
  }

  read(url: string): string | null {
    const token = htmlArtifactToken(url)
    return token ? this.snapshots.get(token) ?? null : null
  }

  release(url: string): void {
    const token = htmlArtifactToken(url)
    if (token) this.snapshots.delete(token)
  }
}
