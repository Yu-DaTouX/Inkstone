import { useEffect, useState, type ReactElement } from 'react'
import { Button, EmptyState, Spinner } from '../../ui'
import { HTML_ARTIFACT_SANDBOX } from '../../../../shared/html-artifact-preview'
import type { PreviewText } from './preview-text'

export const HTML_PREVIEW_TIMEOUT_MS = 20000

export function HtmlPreviewFrame({
  abs,
  name,
  cwd,
  labels,
  onViewSource
}: {
  abs: string
  name: string
  cwd: string
  labels: PreviewText
  onViewSource: () => void
}): ReactElement {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ url: string | null; status: 'loading' | 'ready' | 'error' }>({
    url: null,
    status: 'loading'
  })

  useEffect(() => {
    let live = true
    let url: string | null = null
    setState({ url: null, status: 'loading' })
    void window.yan.prepareHtmlArtifact(abs, cwd).then(
      (result) => {
        if (!result.ok) {
          if (live) setState({ url: null, status: 'error' })
          return
        }
        if (!live) {
          void window.yan.releaseHtmlArtifact(result.url)
          return
        }
        url = result.url
        setState({ url, status: 'loading' })
      },
      () => {
        if (live) setState({ url: null, status: 'error' })
      }
    )
    return () => {
      live = false
      if (url) void window.yan.releaseHtmlArtifact(url)
    }
  }, [abs, cwd, attempt])

  useEffect(() => {
    if (state.status !== 'loading' || !state.url) return undefined
    const current = state.url
    const timer = window.setTimeout(() => {
      void window.yan.releaseHtmlArtifact(current)
      setState((value) => (value.url === current && value.status === 'loading' ? { url: null, status: 'error' } : value))
    }, HTML_PREVIEW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [state.status, state.url])

  if (state.status === 'error') {
    return (
      <EmptyState
        className="v3-preview-media-error"
        data-testid="v3-preview-html-error"
        role="alert"
        title={labels.frameFailed}
        action={
          <>
            <Button size="sm" variant="primary" onPress={onViewSource}>
              {labels.sourceMode}
            </Button>
            <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
              {labels.retry}
            </Button>
          </>
        }
      />
    )
  }

  return (
    <div className="v3-preview-frame" data-testid="v3-preview-html" data-delivered={state.status === 'ready' || undefined}>
      {state.url ? (
        <iframe
          key={state.url}
          className="v3-preview-frame-doc"
          src={state.url}
          title={name}
          sandbox={HTML_ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"
          onLoad={() =>
            setState((value) => (value.url === state.url && value.status === 'loading' ? { ...value, status: 'ready' } : value))
          }
        />
      ) : null}
      {state.status !== 'ready' ? (
        <div className="v3-preview-frame-cover" role="status">
          <Spinner size={18} />
          <span>{labels.htmlLoading}</span>
        </div>
      ) : null}
    </div>
  )
}
