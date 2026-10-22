import { useEffect, useMemo, useState, type JSX } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge, Button, IconButton, Notice } from '../../ui'
import { isHtmlArtifact, type HtmlArtifactPreviewError } from '../../../../shared/html-artifact-preview'
import { filePreviewUrl } from '../../lib/file-preview-url'
import { HtmlArtifactThumb } from '../artifacts/HtmlArtifactThumb'
import { deriveArtifactIdentityKey, useNearViewport, usePreviewSnapshot } from '../artifacts/widget-lifecycle'
import { artifactVersions } from '../artifacts/model'
import type { AssistantArtifact } from '../../../../shared/ipc'
import { Icon } from './Icon'

const HTML_ERROR_KEYS: Record<HtmlArtifactPreviewError, MessageKey> = {
  outside: 'artifact.htmlOutside',
  type: 'artifact.htmlType',
  size: 'artifact.htmlSize',
  read: 'artifact.htmlRead',
  busy: 'artifact.htmlBusy'
}

const isImageArtifact = (artifact: AssistantArtifact): boolean =>
  artifact.previewable && (artifact.kind === 'image' || artifact.kind === 'svg')

function htmlErrorKey(error: string | null): MessageKey {
  return error && Object.prototype.hasOwnProperty.call(HTML_ERROR_KEYS, error)
    ? HTML_ERROR_KEYS[error as HtmlArtifactPreviewError]
    : HTML_ERROR_KEYS.read
}

export function TurnArtifacts({
  artifacts,
  sessionId = null,
  messageId = null
}: {
  artifacts: AssistantArtifact[]
  sessionId?: string | null
  messageId?: string | null
}): JSX.Element | null {
  if (!artifacts.length) return null
  const images = artifacts.filter(isImageArtifact)
  const others = artifacts.filter((artifact) => !isImageArtifact(artifact))
  return (
    <div className="v3-artifact-list" data-testid="v3-artifact-list">
      {images.length ? (
        <div className={`v3-artifact-grid${images.length > 1 ? ' multi' : ''}`}>
          {images.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} sessionId={sessionId} messageId={messageId} />
          ))}
        </div>
      ) : null}
      {others.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} sessionId={sessionId} messageId={messageId} />
      ))}
    </div>
  )
}

function ArtifactCard({
  artifact,
  sessionId,
  messageId
}: {
  artifact: AssistantArtifact
  sessionId: string | null
  messageId: string | null
}): JSX.Element {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const versions = useMemo(
    () => artifactVersions(messages.flatMap((message) => message.artifacts ?? []), artifact),
    [messages, artifact]
  )
  const [pickedId, setPickedId] = useState(artifact.id)
  const index = Math.max(0, versions.findIndex((item) => item.id === pickedId))
  const shown = versions[index] ?? artifact
  const versionBar = versions.length > 1 ? (
    <span className="v3-artifact-versions" role="group" aria-label={t('artifact.versions')} data-testid="v3-artifact-versions">
      <IconButton size="sm" aria-label={t('artifact.prevVersion')} isDisabled={index === 0} onPress={() => setPickedId(versions[index - 1].id)}>
        <Icon name="chevron-left" size={12} />
      </IconButton>
      <span className="v3-artifact-card-meta">
        {t('artifact.versionOf', { n: String(shown.version ?? 1), total: String(versions[versions.length - 1].version ?? versions.length) })}
      </span>
      <IconButton size="sm" aria-label={t('artifact.nextVersion')} isDisabled={index === versions.length - 1} onPress={() => setPickedId(versions[index + 1].id)}>
        <Icon name="chevron-right" size={12} />
      </IconButton>
    </span>
  ) : (shown.version ?? 1) > 1 ? (
    <span className="v3-artifact-card-meta">v{shown.version}</span>
  ) : null
  return <ArtifactCardView key={shown.id} artifact={shown} sessionId={sessionId} messageId={messageId} versionBar={versionBar} />
}

function ArtifactCardView({
  artifact,
  sessionId,
  messageId,
  versionBar
}: {
  artifact: AssistantArtifact
  sessionId: string | null
  messageId: string | null
  versionBar: JSX.Element | null
}): JSX.Element {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const [showSource, setShowSource] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)

  const isHtml = useMemo(() => isHtmlArtifact(artifact), [artifact])
  const isImage = isImageArtifact(artifact)
  const isCode = artifact.kind === 'code' || isHtml
  const unavailable = artifact.unavailable === true || artifact.bytes <= 0
  const openTarget = artifact.sourcePath ?? artifact.path
  const identityKey = deriveArtifactIdentityKey(sessionId, messageId, artifact.id)
  const wantsHtml = isHtml && !unavailable && !showSource

  const [near, nearRef] = useNearViewport<HTMLElement>()
  const snapshot = usePreviewSnapshot({
    identityKey,
    source: wantsHtml ? artifact.path : null,
    active: wantsHtml && near,
    prepare: (path) => window.yan.prepareHtmlArtifact(path),
    release: (url) => window.yan.releaseHtmlArtifact(url)
  })

  useEffect(() => {
    const wantsText = isCode && !unavailable && (!isHtml || showSource)
    if (!wantsText) {
      setText(null)
      setReadError(false)
      return undefined
    }
    let alive = true
    setReadError(false)
    void window.yan
      .readPreview(artifact.path)
      .then((result) => {
        if (!alive) return
        if (result.ok && typeof result.text === 'string') setText(result.text)
        else setReadError(true)
      })
      .catch(() => {
        if (alive) setReadError(true)
      })
    return () => {
      alive = false
    }
  }, [artifact.path, isCode, isHtml, showSource, unavailable])

  const reveal = (): void => {
    void window.yan.revealPath(openTarget).then((result) => {
      if (result?.ok === false && openTarget !== artifact.path) void window.yan.revealPath(artifact.path)
    })
  }

  return (
    <section
      ref={nearRef}
      className="v3-artifact-card"
      role="group"
      aria-label={artifact.filename}
      data-artifact-id={artifact.id}
      data-testid={`v3-artifact-card`}
    >
      <header className="v3-artifact-card-head">
        <Icon name={isImage ? 'image' : 'file'} size={12} />
        <strong className="v3-artifact-card-name" title={artifact.description}>
          {artifact.filename}
        </strong>
        <span className="v3-artifact-card-meta">{formatBytes(artifact.bytes)}</span>
        {versionBar}
        {artifact.provider ? (
          <Badge tone="neutral">
            {artifact.provider}
            {artifact.model ? ` · ${artifact.model}` : ''}
          </Badge>
        ) : null}
        <span className="v3-artifact-card-sp" />
        {isHtml && !unavailable ? (
          <Button size="sm" variant="ghost" onPress={() => setShowSource((value) => !value)}>
            {showSource ? t('artifact.htmlPage') : t('artifact.htmlSource')}
          </Button>
        ) : null}
        {!unavailable ? (
          <>
            <IconButton aria-label={t('artifact.previewHint')} title={t('artifact.previewHint')} onPress={() => void previewFile(artifact.path)}>
              <Icon name="file" size={14} />
            </IconButton>
            <IconButton aria-label={t('artifact.revealHint')} title={t('artifact.revealHint')} onPress={reveal}>
              <Icon name="folder" size={14} />
            </IconButton>
            <IconButton
              aria-label={t('artifact.copyPathHint')}
              title={t('artifact.copyPathHint')}
              onPress={() => void navigator.clipboard.writeText(openTarget)}
            >
              <Icon name="copy" size={14} />
            </IconButton>
          </>
        ) : null}
      </header>

      {artifact.description && !isImage ? <p className="v3-artifact-card-desc">{artifact.description}</p> : null}

      {isImage ? (
        <div className={`v3-artifact-image${unavailable ? ' failed' : ''}`}>
          {!unavailable ? (
            <img
              src={filePreviewUrl(artifact.path)}
              alt={artifact.filename}
              title={t('artifact.zoomHint')}
              onClick={() => void previewFile(artifact.path)}
            />
          ) : (
            <Notice tone="fail" compact>{artifact.error || t('artifact.noPreview')}</Notice>
          )}
        </div>
      ) : null}

      {isHtml && !unavailable ? (
        showSource ? (
          <pre className="v3-artifact-code">
            <code>{readError ? t('artifact.htmlRead') : text ?? t('artifact.reading')}</code>
          </pre>
        ) : snapshot.url ? (
          <HtmlArtifactThumb url={snapshot.url} title={artifact.filename} openLabel={t('artifact.previewHint')} onOpen={() => void previewFile(artifact.path)} />
        ) : snapshot.status === 'paused' ? (
          <Notice
            compact
            data-testid="v3-artifact-paused"
            action={
              <Button size="sm" variant="ghost" onPress={snapshot.resume}>
                {t('artifact.htmlRetry')}
              </Button>
            }
          >
            {t('artifact.htmlBusy')}
          </Notice>
        ) : (
          <Notice tone={snapshot.status === 'error' ? 'fail' : 'info'} compact>
            {snapshot.status === 'error' ? t(htmlErrorKey(snapshot.error)) : t('artifact.reading')}
          </Notice>
        )
      ) : isCode ? (
        <pre className="v3-artifact-code">
          <code>{unavailable ? artifact.error || t('artifact.noPreview') : readError ? t('artifact.htmlRead') : text ?? t('artifact.reading')}</code>
        </pre>
      ) : artifact.previewable && !unavailable ? (
        <div className="v3-artifact-card-open">
          <Button size="sm" variant="ghost" onPress={() => void previewFile(artifact.path)} data-testid="v3-artifact-preview">
            {t('artifact.previewHint')}
          </Button>
        </div>
      ) : (
        <Notice tone={unavailable ? 'fail' : 'info'} compact>{unavailable ? artifact.error || t('artifact.unavailable') : t('artifact.binary')}</Notice>
      )}
    </section>
  )
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
