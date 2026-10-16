import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../../icons/Icon'
import { IconButton, Segmented } from '../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'
import { resolveRelativePath } from '../../../../shared/file-resource'
import { officeFormatOf } from '../../../../shared/office'
import { OfficePreview } from '../review/OfficeContent'
import { filePreviewUrl } from '../../lib/file-preview-url'

const MAX_RENDER_LINES = 2000
const MAX_MARKDOWN_CHARS = 64 * 1024

export function FilePreviewPane({ focus = false, onToggleFocus, resourceKey }: { focus?: boolean; onToggleFocus?: () => void; resourceKey?: string } = {}) {
  const t = useT()
  const preview = useStore((s) => resourceKey ? s.filePreviews[resourceKey] : s.filePreview)
  const previewFile = useStore((s) => s.previewFile)
  const checkPreviewStale = useStore((s) => s.checkPreviewStale)
  const openBrowser = useStore((s) => s.openBrowser)
  const pollMs =
    Number((window as unknown as { __YAN_PREVIEW_POLL_MS?: number }).__YAN_PREVIEW_POLL_MS) || 5000
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'read' | 'source'>('read')

  const data = preview?.data
  const isMarkdown = data?.kind === 'text' && /\.(?:md|markdown|mdown)$/i.test(data.name)
  const rangeStart = data?.line
  const rangeEnd = data?.lineEnd ?? data?.line
  const inRange = (n: number): boolean =>
    !!rangeStart && n >= rangeStart && n <= (rangeEnd ?? rangeStart)

  useEffect(() => {
    setMode(preview?.line ? 'source' : 'read')
  }, [preview?.path, preview?.cwd, preview?.line])
  const lines = useMemo(() => {
    if (!data?.text) return []
    const all = data.text.split('\n')
    return all.length > MAX_RENDER_LINES ? all.slice(0, MAX_RENDER_LINES) : all
  }, [data?.text])
  const markdownText = useMemo(() => {
    let text = lines.join('\n').slice(0, MAX_MARKDOWN_CHARS)
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
    return text
  }, [lines])
  const startLine = data?.windowStart ?? 1

  useEffect(() => {
    const line = data?.line
    const el = bodyRef.current
    if (!line || !el) return
    const target = el.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (target) {
      el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 3)
    } else {
      const base = data?.windowStart ?? 1
      const lh = 18
      el.scrollTop = Math.max(0, (line - base) * lh - el.clientHeight / 3)
    }
  }, [data?.line, data?.abs, data?.windowStart])

  useEffect(() => {
    const abs = data?.abs
    if (!abs || !data?.ok || typeof data.mtimeMs !== 'number') return
    const timer = window.setInterval(() => void checkPreviewStale(resourceKey), pollMs)
    return () => window.clearInterval(timer)
  }, [data?.abs, data?.ok, data?.mtimeMs, pollMs, checkPreviewStale, resourceKey])

  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [imgMode, setImgMode] = useState<'fit' | 'actual'>('fit')
  useEffect(() => {
    setImgSize(null)
    setImgMode('fit')
  }, [data?.abs])

  if (!preview) return null

  const isImage = data?.ok && data.kind === 'image'
  const fileUrl = data?.abs ? filePreviewUrl(data.abs) : ''
  const isOffice = !!data?.ok && (data.kind === 'binary' || data.kind === 'pdf') && !!officeFormatOf(data.name ?? '')
  const canOpenExternally = data?.ok && (data.kind === 'text' || data.kind === 'image' || isOffice)
  const isText = data?.ok && data.kind === 'text'

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
    <div className="fp" data-testid="file-preview" data-file-name={data?.name || preview.path}>
      <div className="fp-head">
        {data?.line ? (
          <span className="fp-line-no" data-testid="file-preview-line">
            {data.lineEnd ? `${data.line}\u2013${data.lineEnd}` : data.line}
          </span>
        ) : null}
        {!isImage && data?.size ? <span className="fp-size">{fmtSize(data.size)}</span> : null}
        {isMarkdown ? (
          <Segmented
            size="sm"
            className="fp-mode"
            label={t('fp.mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'read', label: t('fp.modeRead'), testId: 'file-preview-read' },
              { value: 'source', label: t('fp.modeSource'), testId: 'file-preview-source' }
            ]}
          />
        ) : null}
        <span className="spacer" />
        <IconButton
          size="sm"
          icon="copy"
          label={t('fp.copyPath')}
          onClick={() => void navigator.clipboard.writeText(data?.abs || preview.path)}
        />
        {onToggleFocus ? (
          <IconButton
            size="sm"
            icon="maximize"
            label={focus ? t('fp.unfocus') : t('fp.focus')}
            onClick={onToggleFocus}
            data-testid="file-preview-focus"
          />
        ) : null}
        {data?.abs ? (
          <IconButton
            size="sm"
            icon="folder-open"
            label={t('fp.reveal')}
            onClick={() => void window.yan.revealPath(data.abs)}
          />
        ) : null}
        {canOpenExternally && data?.abs ? (
          <IconButton
            size="sm"
            icon="external"
            label={t('fp.open')}
            onClick={() => void window.yan.openFileDefault(data.abs)}
          />
        ) : null}
      </div>

      <div className="fp-path" title={data?.abs || preview.path} hidden={isImage || !dirOf(data?.abs || preview.path)}>
        {dirOf(data?.abs || preview.path).replace(/[\\/]+/g, ' › ')}
      </div>

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
            <button type="button" className="fp-retry" onClick={() => void previewFile(preview.path, preview.line, preview.cwd, preview.lineEnd)} data-testid="file-preview-retry">{t('fp.retry')}</button>
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
          <>
            {(data.text?.length ?? 0) > MAX_MARKDOWN_CHARS ? <div className="fp-note">{t('fp.truncated')}</div> : null}
            <div className="fp-markdown prose md" data-testid="file-preview-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {markdownText}
              </ReactMarkdown>
            </div>
            {(data.text?.split('\n').length ?? 0) > MAX_RENDER_LINES ? (
              <div className="fp-note">{t('fp.tooManyLines', { n: MAX_RENDER_LINES })}</div>
            ) : null}
            {data?.truncated ? <div className="fp-note">{t('fp.truncated')}</div> : null}
          </>
        ) : null}

        {isText && (!isMarkdown || mode === 'source') ? (
          <>
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
            {(data.text?.split('\n').length ?? 0) > MAX_RENDER_LINES ? (
              <div className="fp-note">{t('fp.tooManyLines', { n: MAX_RENDER_LINES })}</div>
            ) : null}
            {data?.truncated ? <div className="fp-note">{t('fp.truncated')}</div> : null}
          </>
        ) : null}

        {isImage && fileUrl ? (
          <div className={`fp-image ${imgMode}`} data-testid="file-preview-image" data-mode={imgMode}>
            <button
              type="button"
              className="fp-image-hit"
              onClick={() => setImgMode((m) => (m === 'fit' ? 'actual' : 'fit'))}
              title={t('fp.imageToggle')}
              aria-label={t('fp.imageToggle')}
            >
              <img
                src={fileUrl}
                alt={data.name}
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget
                  if (el.naturalWidth > 0) setImgSize({ w: el.naturalWidth, h: el.naturalHeight })
                }}
              />
            </button>
            <div className="fp-image-meta" data-testid="file-preview-image-meta">
              <span>{imgMode === 'fit' ? t('fp.imageFit') : t('fp.imageActual')}</span>
              {imgSize ? (
                <span className="fp-image-dims">
                  {imgSize.w}×{imgSize.h}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {isOffice && data?.abs ? <OfficePreview path={data.abs} cwd={preview.cwd} version={data.mtimeMs} /> : null}

        {data?.ok && !isOffice && (data.kind === 'binary' || data.kind === 'pdf') ? (
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

function dirOf(path: string): string {
  return path.replace(/[\\/]+[^\\/]*$/, '')
}
