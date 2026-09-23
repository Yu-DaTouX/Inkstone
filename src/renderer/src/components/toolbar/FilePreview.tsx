import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'
import { resolveRelativePath } from '../../../../shared/file-resource'

/**
 * 右侧的只读文件预览（方案 5.2 / 5.3 的「可查看」阶段）。
 *
 * 边界（明确写出来，避免误以为它是编辑器）：
 *   · **只读** —— 不写回、不执行、不保存；
 *   · HTML / Markdown 只按文本显示，**不渲染**，所以不会执行脚本；
 *   · 文本前 2MB（主进程截断），超出明确标注；
 *   · 二进制只给元信息 + 「在资源管理器中显示」；
 *   · 行号来自链接里的 `path:42`，打开后滚到那一行。
 *
 * ⚠️ 为什么不自己 setBounds：原生 `WebContentsView` 由主进程管。
 *    这里只负责 DOM；浏览器视图的隐藏/恢复在 store 的 previewFile/closePreview。
 */

/** 一次最多渲染多少行（2MB 文本可能有几万行，全铺出来会卡） */
const MAX_RENDER_LINES = 2000

export function FilePreviewPane() {
  const t = useT()
  const preview = useStore((s) => s.filePreview)
  const closePreview = useStore((s) => s.closePreview)
  const previewFile = useStore((s) => s.previewFile)
  const checkPreviewStale = useStore((s) => s.checkPreviewStale)
  const openBrowser = useStore((s) => s.openBrowser)
  /*
   * 变化提示（H-4）轮询间隔：默认 5s；探针可用 `window.__YAN_PREVIEW_POLL_MS`
   * 放快，但产品行为不靠那个变量（没设就是 5s）。
   */
  const pollMs =
    Number((window as unknown as { __YAN_PREVIEW_POLL_MS?: number }).__YAN_PREVIEW_POLL_MS) || 5000
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'read' | 'source'>('read')

  const data = preview?.data
  const isMarkdown = data?.kind === 'text' && /\.(?:md|markdown|mdown)$/i.test(data.name)
  /* 范围高亮（H-4）：`#L42-L60` 是高亮区间，不是文件名的一部分 */
  const rangeStart = data?.line
  const rangeEnd = data?.lineEnd ?? data?.line
  const inRange = (n: number): boolean =>
    !!rangeStart && n >= rangeStart && n <= (rangeEnd ?? rangeStart)

  /* 新资源默认阅读模式；带行号优先源码定位，但用户仍可切回阅读。 */
  useEffect(() => {
    setMode(preview?.line ? 'source' : 'read')
  }, [preview?.path, preview?.cwd, preview?.line])
  const lines = useMemo(() => {
    if (!data?.text) return []
    const all = data.text.split('\n')
    return all.length > MAX_RENDER_LINES ? all.slice(0, MAX_RENDER_LINES) : all
  }, [data?.text])
  /* 窗口化的文件：行号从真实起始行开始，不重新从 1 数 */
  const startLine = data?.windowStart ?? 1

  /* 滚到链接里指定的行（`path:42`） */  useEffect(() => {
    const line = data?.line
    const el = bodyRef.current
    if (!line || !el) return
    const target = el.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (target) {
      el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 3)
    } else {
      /* 目标行不在这次渲染里：只在**同一段窗口**内按行高估算，不跨窗口瞎猜 */
      const base = data?.windowStart ?? 1
      const lh = 18
      el.scrollTop = Math.max(0, (line - base) * lh - el.clientHeight / 3)
    }
  }, [data?.line, data?.abs, data?.windowStart])

  /* 变化提示（H-4）：只 stat 一下，不为了看一眼 mtime 重读整份内容 */
  useEffect(() => {
    const abs = data?.abs
    if (!abs || !data?.ok || typeof data.mtimeMs !== 'number') return
    const timer = window.setInterval(() => void checkPreviewStale(), pollMs)
    return () => window.clearInterval(timer)
  }, [data?.abs, data?.ok, data?.mtimeMs, pollMs, checkPreviewStale])

  if (!preview) return null

  const fileUrl = data?.abs
    ? `file:///${encodeURI(data.abs.replace(/\\/g, '/').replace(/^\/+/, ''))}`
    : ''
  const canOpenExternally = data?.ok && (data.kind === 'text' || data.kind === 'image')
  const isText = data?.ok && data.kind === 'text'

  /**
   * 阅读模式里的链接（H-4 出口 3）：
   * 相对路径以**这篇文档所在目录**为基准（`../README.md` 指向文档的上一级），
   * 而不是会话工作目录；URL 仍然进内部浏览器。
   */
  const docDir = useMemo(
    () => (data?.abs ? data.abs.replace(/[\\/][^\\/]*$/, '') : ''),
    [data?.abs]
  )
  const mdComponents = useMemo(() => {
    const DocLink = ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const target = classifyLink(href)
      if (target.kind === 'invalid') return <span className="md-link blocked">{children}</span>
      const title =
        target.kind === 'file'
          ? t('link.preview', {
              path: `${target.path}${target.line ? `:${target.line}` : ''}`
            })
          : target.url
      return (
        <a
          href="#"
          className="md-link"
          data-link-kind={target.kind}
          title={title}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (target.kind === 'url') void openBrowser(target.url)
            else if (target.kind === 'file') {
              void previewFile(resolveRelativePath(docDir, target.path), target.line, undefined, target.lineEnd)
            }
          }}
        >
          {children}
        </a>
      )
    }
    return { a: DocLink }
  }, [docDir, openBrowser, previewFile, t])

  return (
    <div className="fp" data-testid="file-preview">
      <div className="fp-head">
        <Icon name="tag" size={12} />
        <span className="fp-name" title={data?.abs || preview.path}>
          {data?.name || preview.path}
        </span>
        {data?.line ? (
          <span className="fp-line-no" data-testid="file-preview-line">
            {data.lineEnd ? `${data.line}\u2013${data.lineEnd}` : data.line}
          </span>
        ) : null}
        {data?.size ? <span className="fp-size">{fmtSize(data.size)}</span> : null}
        {isMarkdown ? (
          <div className="fp-mode" role="group" aria-label="文件阅读模式">
            <button type="button" className={mode === 'read' ? 'on' : ''} onClick={() => setMode('read')} data-testid="file-preview-read">阅读</button>
            <button type="button" className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')} data-testid="file-preview-source">源码</button>
          </div>
        ) : null}
        <span className="spacer" />
        <button
          className="fp-act"
          onClick={() => void navigator.clipboard.writeText(data?.abs || preview.path)}
          title={t('fp.copyPath')}
          aria-label={t('fp.copyPath')}
        >
          <Icon name="layers" size={12} />
        </button>
        {data?.abs ? (
          <button
            className="fp-act"
            onClick={() => void window.yan.revealPath(data.abs)}
            title={t('fp.reveal')}
            aria-label={t('fp.reveal')}
          >
            <Icon name="folder-open" size={12} />
          </button>
        ) : null}
        {canOpenExternally && data?.abs ? (
          <button
            className="fp-act"
            onClick={() => void window.yan.openPath(data.abs)}
            title={t('fp.open')}
            aria-label={t('fp.open')}
          >
            <Icon name="globe" size={12} />
          </button>
        ) : null}
        <button
          className="fp-act"
          onClick={closePreview}
          title={t('fp.close')}
          aria-label={t('fp.close')}
          data-testid="file-preview-close"
        >
          <Icon name="plus" size={12} className="fp-x" />
        </button>
      </div>

      <div className="fp-path" title={preview.path}>
        {preview.path}
      </div>

      {/* 内容被外部改写：就地说一声，不自动重载、不抢回阅读位置 */}
      {preview.stale ? (
        <div className="fp-updated" data-testid="file-preview-updated" role="status">
          <Icon name="alert-circle" size={12} />
          <span>{t('fp.updated')}</span>
          <button
            type="button"
            className="fp-reload"
            data-testid="file-preview-reload"
            onClick={() => void previewFile(preview.path, preview.line, preview.cwd, preview.lineEnd)}
          >
            {t('fp.reload')}
          </button>
        </div>
      ) : null}

      <div className="fp-body" ref={bodyRef} data-testid="file-preview-body">
        {preview.loading ? <div className="fp-note">{t('fp.loading')}</div> : null}

        {!preview.loading && data && !data.ok ? (
          <div className="fp-note err" role="alert">
            {data.error ?? t('fp.failed')}
            <div className="fp-path-line">{preview.path}</div>
            <button type="button" className="fp-retry" onClick={() => void previewFile(preview.path, preview.line, preview.cwd, preview.lineEnd)} data-testid="file-preview-retry">重试</button>
            {/* 文件不在了就给一条去其父目录的出口（H-4）；越界类错误不带 dir */}
            {data.dir ? (
              <button
                type="button"
                className="fp-retry"
                data-testid="file-preview-reveal-dir"
                onClick={() => void window.yan.revealPath(data.dir as string)}
              >
                {t('fp.revealDir')}
              </button>
            ) : null}
          </div>
        ) : null}

        {isText && isMarkdown && mode === 'read' ? (
          <div className="fp-markdown prose" data-testid="file-preview-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {data.text ?? ''}
            </ReactMarkdown>
          </div>
        ) : null}

        {isText && (!isMarkdown || mode === 'source') ? (
          <>
            {/* 大文件只给了窗口：先说清这是全文的哪一段，再画行（H-4） */}
            {data?.windowStart ? (
              <div className="fp-note" data-testid="file-preview-window">
                {t('fp.window', {
                  from: data.windowStart,
                  to: data.windowEnd ?? data.windowStart,
                  total: data.totalLines ?? ''
                })}
              </div>
            ) : null}
            <pre className="fp-code">
              {lines.map((text, i) => {
                const n = startLine + i
                return (
                  <div
                    className={`fp-row${inRange(n) ? ' fp-row-range' : ''}`}
                    key={n}
                    data-line={n}
                    data-in-range={inRange(n) ? '1' : undefined}
                  >
                    <span className="fp-gutter" aria-hidden>
                      {n}
                    </span>
                    <span className="fp-text">{text || '\u00a0'}</span>
                  </div>
                )
              })}
            </pre>
            {lines.length === MAX_RENDER_LINES ? (
              <div className="fp-note">{t('fp.tooManyLines', { n: MAX_RENDER_LINES })}</div>
            ) : null}
            {data?.truncated ? <div className="fp-note">{t('fp.truncated')}</div> : null}
          </>
        ) : null}

        {data?.ok && data.kind === 'image' && fileUrl ? (
          <div className="fp-image">
            <img src={fileUrl} alt={data.name} />
          </div>
        ) : null}

        {data?.ok && (data.kind === 'binary' || data.kind === 'pdf') ? (
          <div className="fp-note">
            {data.kind === 'pdf' ? t('fp.pdf') : t('fp.binary')}
            <div className="fp-path-line">{t('fp.binaryHint')}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
