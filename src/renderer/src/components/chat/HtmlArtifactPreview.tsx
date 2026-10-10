import { useEffect, useRef, useState } from 'react'
import { HTML_ARTIFACT_SANDBOX, type HtmlArtifactPreviewError } from '../../../../shared/html-artifact-preview'
import { useT, type MessageKey } from '../../i18n'
import { Button } from '../ui'

const ERROR_KEYS: Record<HtmlArtifactPreviewError, MessageKey> = {
  outside: 'artifact.htmlOutside',
  type: 'artifact.htmlType',
  size: 'artifact.htmlSize',
  read: 'artifact.htmlRead',
  busy: 'artifact.htmlBusy'
}

/** 离视口这么远就卸载页面、只留同高占位：长会话里同时活着的 iframe 数量受控，回来时重新载入。 */
const KEEP_MARGIN = '1200px'
const LOAD_MARGIN = '240px'

/**
 * 页面不接收宿主消息，也不持有任何桥接对象；卸载立即释放 URL 对应的快照。
 * 页面内的操作只在本次载入里有效：滚远卸载、重新载入或重开历史都会重置（界面上说明，不显示「已保存」）。
 */
export function HtmlArtifactPreview({ path, filename, expanded, reloadToken }: { path: string; filename: string; expanded: boolean; reloadToken: number }) {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<HtmlArtifactPreviewError | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const node = root.current
    if (!node) return
    /* 进入近处才载入；离得很远才卸载 —— 两道边界不同，避免在边缘来回载入 */
    const load = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { rootMargin: LOAD_MARGIN })
    const keep = new IntersectionObserver((entries) => {
      if (entries.every((entry) => !entry.isIntersecting)) setNear(false)
    }, { rootMargin: KEEP_MARGIN })
    load.observe(node)
    keep.observe(node)
    return () => { load.disconnect(); keep.disconnect() }
  }, [])

  useEffect(() => {
    if (!near) { setUrl(null); return }
    let alive = true
    let preparedUrl: string | null = null
    setError(null)
    void window.yan.prepareHtmlArtifact(path).then((result) => {
      if (!result.ok) {
        if (alive) setError(result.error)
        return
      }
      preparedUrl = result.url
      if (alive) setUrl(result.url)
      else void window.yan.releaseHtmlArtifact(result.url).catch(() => undefined)
    }).catch(() => { if (alive) setError('read') })
    return () => {
      alive = false
      setUrl(null)
      if (preparedUrl) void window.yan.releaseHtmlArtifact(preparedUrl).catch(() => undefined)
    }
  }, [path, near, reloadToken, retry])

  return (
    <div ref={root} className={`artifact-html-stage${expanded ? ' expanded' : ''}`} data-testid="artifact-html-stage" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {url ? <iframe
        key={url}
        className="ui-html-preview artifact-html-frame"
        src={url}
        title={t('artifact.htmlTitle', { name: filename })}
        sandbox={HTML_ARTIFACT_SANDBOX}
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"
        data-testid="artifact-html-frame"
      /> : <div className={`artifact-html-placeholder${error ? ' failed' : ''}`} role={error ? 'alert' : 'status'}>
        <span>{error ? t(ERROR_KEYS[error]) : near ? t('artifact.reading') : t('artifact.htmlParked')}</span>
        {error && error !== 'outside' && error !== 'type' && error !== 'size'
          ? <Button size="sm" icon="refresh" onClick={() => setRetry((n) => n + 1)}>{t('artifact.htmlRetry')}</Button>
          : null}
      </div>}
    </div>
  )
}
