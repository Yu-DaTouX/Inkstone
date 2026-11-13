import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Maximize2 } from '../../ui/icons'
import { Badge } from '../../ui'
import { HTML_ARTIFACT_SANDBOX, HTML_PREVIEW_CHANNEL, readProbeReply } from '../../../../shared/html-artifact-preview'

const VIEW_WIDTH = 1280
const VIEW_HEIGHT = 800
const MAX_HEIGHT = 360
const MIN_HEIGHT = 120

export function HtmlArtifactThumb({ url, title, openLabel, onOpen }: { url: string; title: string; openLabel: string; onOpen: () => void }): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [docHeight, setDocHeight] = useState(0)

  useEffect(() => {
    setDocHeight(0)
  }, [url])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
      const reply = readProbeReply(event.data)
      if (reply && reply.docHeight > 0) setDocHeight(reply.docHeight)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const observer = new ResizeObserver(() => setWidth(box.clientWidth))
    observer.observe(box)
    setWidth(box.clientWidth)
    return () => observer.disconnect()
  }, [])

  const scale = width > 0 ? width / VIEW_WIDTH : 0
  const contentHeight = docHeight > 0 ? Math.round(docHeight * scale) : 0
  const height = scale ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, contentHeight || Math.round(VIEW_HEIGHT * scale))) : 0

  const askHeight = (frame: HTMLIFrameElement): void => {
    frame.contentWindow?.postMessage({ [HTML_PREVIEW_CHANNEL]: 'chrome', bare: true }, '*')
    frame.contentWindow?.postMessage({ [HTML_PREVIEW_CHANNEL]: 'probe', id: 1, follow: false }, '*')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen()
  }

  return (
    <div
      ref={boxRef}
      className="v3-artifact-thumb"
      role="button"
      tabIndex={0}
      aria-label={`${openLabel} · ${title}`}
      title={openLabel}
      data-testid="v3-artifact-thumb"
      style={{ height: height || undefined }}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {scale ? (
        <iframe
          ref={frameRef}
          src={url}
          title={title}
          tabIndex={-1}
          aria-hidden
          sandbox={HTML_ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          style={{ width: VIEW_WIDTH, height: VIEW_HEIGHT, transform: `scale(${scale})` }}
          onLoad={(event) => askHeight(event.currentTarget)}
        />
      ) : null}
      <span className="v3-artifact-thumb-open">
        <Badge tone="neutral" overlay className="v3-artifact-thumb-badge">
          <Maximize2 size={12} aria-hidden />
          {openLabel}
        </Badge>
      </span>
    </div>
  )
}
