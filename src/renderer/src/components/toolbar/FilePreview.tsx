import { useEffect, useMemo, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

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
  const bodyRef = useRef<HTMLDivElement>(null)

  const data = preview?.data
  const lines = useMemo(() => {
    if (!data?.text) return []
    const all = data.text.split('\n')
    return all.length > MAX_RENDER_LINES ? all.slice(0, MAX_RENDER_LINES) : all
  }, [data?.text])

  /* 滚到链接里指定的行（`path:42`） */
  useEffect(() => {
    const line = data?.line
    const el = bodyRef.current
    if (!line || !el) return
    const target = el.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (target) {
      el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 3)
    } else {
      /* 目标行没渲染出来（超出上限）就按估算滚 */
      const lh = 18
      el.scrollTop = Math.max(0, (line - 1) * lh - el.clientHeight / 3)
    }
  }, [data?.line, data?.abs])

  if (!preview) return null

  const fileUrl = data?.abs
    ? `file:///${encodeURI(data.abs.replace(/\\/g, '/').replace(/^\/+/, ''))}`
    : ''
  const canOpenExternally = data?.ok && (data.kind === 'text' || data.kind === 'image')
  const isText = data?.ok && data.kind === 'text'

  return (
    <div className="fp" data-testid="file-preview">
      <div className="fp-head">
        <Icon name="tag" size={12} />
        <span className="fp-name" title={data?.abs || preview.path}>
          {data?.name || preview.path}
        </span>
        {data?.line ? <span className="fp-line-no">{data.line}</span> : null}
        {data?.size ? <span className="fp-size">{fmtSize(data.size)}</span> : null}
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

      <div className="fp-body" ref={bodyRef} data-testid="file-preview-body">
        {preview.loading ? <div className="fp-note">{t('fp.loading')}</div> : null}

        {!preview.loading && data && !data.ok ? (
          <div className="fp-note err" role="alert">
            {data.error ?? t('fp.failed')}
            <div className="fp-path-line">{preview.path}</div>
          </div>
        ) : null}

        {isText ? (
          <>
            <pre className="fp-code">
              {lines.map((line, i) => (
                <div className="fp-row" key={i} data-line={i + 1}>
                  <span className="fp-gutter" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="fp-text">{line || '\u00a0'}</span>
                </div>
              ))}
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
