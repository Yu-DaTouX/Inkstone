import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, EmptyState, Spinner } from '../../ui'
import { HTML_ARTIFACT_SANDBOX, HTML_PREVIEW_CHANNEL, readProbeReply, type HtmlPreviewRect } from '../../../../shared/html-artifact-preview'
import type { PreviewText } from './preview-text'

export const HTML_PREVIEW_TIMEOUT_MS = 20000

const FRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"

export interface PreviewFocus {
  text: string | null
}

let probeSeq = 0
const PROBE_RETRIES = 4
const PROBE_RETRY_MS = 300

interface FrameState {
  shown: string | null
  pending: string | null
  status: 'loading' | 'ready' | 'error'
}

export function HtmlPreviewFrame({
  abs,
  name,
  cwd,
  labels,
  revision = 0,
  draft = null,
  focus = null,
  follow = false,
  onFocusRect,
  onViewSource
}: {
  abs: string
  name: string
  cwd: string
  labels: PreviewText
  revision?: number
  draft?: string | null
  focus?: PreviewFocus | null
  follow?: boolean
  onFocusRect?: (rect: HtmlPreviewRect | null) => void
  onViewSource: () => void
}): ReactElement {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<FrameState>({ shown: null, pending: null, status: 'loading' })
  const urlsRef = useRef(new Set<string>())
  const framesRef = useRef(new Map<string, HTMLIFrameElement>())
  const probeRef = useRef(0)
  const onFocusRectRef = useRef(onFocusRect)
  onFocusRectRef.current = onFocusRect
  const focusText = focus ? focus.text ?? '' : null

  const probedRef = useRef(false)
  useEffect(() => {
    if (focusText !== null || !probedRef.current || !state.shown) return
    probedRef.current = false
    framesRef.current.get(state.shown)?.contentWindow?.postMessage({ [HTML_PREVIEW_CHANNEL]: 'restore' }, '*')
  }, [focusText, state.shown])

  useEffect(() => {
    if (focusText === null || !state.shown) return undefined
    probedRef.current = true
    const frame = framesRef.current.get(state.shown)
    if (!frame) return undefined
    let attempts = 0
    let timer = 0
    const send = (): void => {
      const id = ++probeSeq
      probeRef.current = id
      frame.contentWindow?.postMessage({ [HTML_PREVIEW_CHANNEL]: 'probe', id, text: focusText || null, follow }, '*')
    }
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return
      const reply = readProbeReply(event.data)
      if (!reply || reply.id !== probeRef.current) return
      if (reply.rect || attempts >= PROBE_RETRIES) {
        onFocusRectRef.current?.(reply.rect)
        return
      }
      attempts++
      timer = window.setTimeout(send, PROBE_RETRY_MS)
    }
    window.addEventListener('message', onMessage)
    send()
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
    }
  }, [focusText, follow, state.shown])

  const release = (url: string | null): void => {
    if (!url || !urlsRef.current.delete(url)) return
    void window.yan.releaseHtmlArtifact(url)
  }

  useEffect(() => {
    const urls = urlsRef.current
    return () => {
      for (const url of urls) void window.yan.releaseHtmlArtifact(url)
      urls.clear()
    }
  }, [])

  useEffect(() => {
    setState((value) => {
      release(value.shown)
      release(value.pending)
      return { shown: null, pending: null, status: 'loading' }
    })
  }, [abs, cwd, attempt])

  useEffect(() => {
    let live = true
    const drafting = draft !== null
    if (drafting && !draft.trim()) return undefined
    const request = drafting ? window.yan.prepareHtmlWidget(draft) : window.yan.prepareHtmlArtifact(abs, cwd)
    void request.then(
      (result) => {
        if (!result.ok) {
          if (live && !drafting) setState((value) => (value.shown ? value : { shown: null, pending: null, status: 'error' }))
          return
        }
        if (!live) {
          void window.yan.releaseHtmlArtifact(result.url)
          return
        }
        urlsRef.current.add(result.url)
        setState((value) => {
          release(value.pending)
          return { ...value, pending: result.url }
        })
      },
      () => {
        if (live && !drafting) setState((value) => (value.shown ? value : { shown: null, pending: null, status: 'error' }))
      }
    )
    return () => {
      live = false
    }
  }, [abs, cwd, attempt, revision, draft])

  useEffect(() => {
    if (!state.pending) return undefined
    const current = state.pending
    const timer = window.setTimeout(() => {
      setState((value) => {
        if (value.pending !== current) return value
        release(current)
        return value.shown ? { ...value, pending: null } : { shown: null, pending: null, status: 'error' }
      })
    }, HTML_PREVIEW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [state.pending])

  const promote = (url: string): void => {
    setState((value) => {
      if (value.pending !== url) return value
      release(value.shown)
      return { shown: url, pending: null, status: 'ready' }
    })
  }

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
      {[state.shown, state.pending].map((url) =>
        url ? (
          <iframe
            key={url}
            ref={(element) => {
              if (element) framesRef.current.set(url, element)
              else framesRef.current.delete(url)
            }}
            className="v3-preview-frame-doc"
            data-pending={url === state.pending || undefined}
            src={url}
            title={name}
            sandbox={HTML_ARTIFACT_SANDBOX}
            referrerPolicy="no-referrer"
            allow={FRAME_ALLOW}
            onLoad={() => promote(url)}
          />
        ) : null
      )}
      {state.status !== 'ready' ? (
        <div className="v3-preview-frame-cover" role="status">
          <Spinner size={18} />
          <span>{labels.htmlLoading}</span>
        </div>
      ) : null}
    </div>
  )
}
