import { formatBytes } from '../diff/limits'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../state/store'
import { Badge, Button, IconButton, Notice, TermSpinner } from '../../ui'
import { isHtmlArtifact, type HtmlArtifactPreviewError } from '../../../../shared/html-artifact-preview'
import { filePreviewUrl } from '../../lib/file-preview-url'
import { HtmlArtifactThumb } from '../artifacts/HtmlArtifactThumb'
import { deriveArtifactIdentityKey, useNearViewport, usePreviewSnapshot } from '../artifacts/widget-lifecycle'
import { artifactVersions } from '../artifacts/model'
import type { AssistantArtifact, ImageGenerationProgress, UIMessage } from '../../../../shared/ipc'
import { Icon } from './Icon'
import { ImageViewer, type ViewerImage } from '../composer/image-viewer'
import { previewFormatOf } from '../preview/preview-format'

const CODE_PREVIEW_LINES = 12
const TEXT_CACHE_LIMIT = 32
const TEXT_CACHE_CHARS = 2_000_000
const textCache = new Map<string, string>()
let textCacheChars = 0

function artifactTextKey(artifact: AssistantArtifact): string {
  return JSON.stringify([artifact.path, artifact.sha256, artifact.createdAt, artifact.bytes])
}

function cacheArtifactText(key: string, text: string): void {
  if (text.length > TEXT_CACHE_CHARS) return
  textCacheChars -= textCache.get(key)?.length ?? 0
  textCache.delete(key)
  textCache.set(key, text)
  textCacheChars += text.length
  while (textCache.size > TEXT_CACHE_LIMIT || textCacheChars > TEXT_CACHE_CHARS) {
    const oldest = textCache.keys().next().value!
    textCacheChars -= textCache.get(oldest)!.length
    textCache.delete(oldest)
  }
}

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
  imageProgress = [],
  sessionId = null,
  messageId = null
}: {
  artifacts: AssistantArtifact[]
  imageProgress?: readonly ImageGenerationProgress[]
  sessionId?: string | null
  messageId?: string | null
}): JSX.Element | null {
  const imageArtifacts = artifacts.filter(isImageArtifact)
  const jobs = imageProgress.flatMap((job) => {
    const result = job.artifactId ? imageArtifacts.find((artifact) => artifact.id === job.artifactId) : undefined
    return result || job.stage !== 'done' ? [{ job, result }] : []
  })
  if (!artifacts.length && !jobs.length) return null
  const placed = new Set(jobs.map(({ result }) => result?.id))
  const images = imageArtifacts.filter(({ id }) => !placed.has(id))
  const others = artifacts.filter((artifact) => !isImageArtifact(artifact))
  const gallery = imageArtifacts.length > 1 ? imageArtifacts.filter(({ unavailable }) => !unavailable).map((artifact) => ({
    src: filePreviewUrl(artifact.path), alt: artifact.filename, caption: artifact.description
  })) : undefined
  const imageCount = images.length + jobs.length
  return (
    <div className="v3-artifact-list" data-testid="v3-artifact-list">
      {imageCount ? (
        <div className={`v3-artifact-grid${imageCount > 1 ? ' multi' : ''}`}>
          {jobs.map(({ job, result }) => (
            <div key={job.id} className="v3-generated-slot" data-testid="generated-image-slot" data-image-state={result ? 'done' : job.stage}>
              {result ? <ArtifactCard artifact={result} sessionId={sessionId} messageId={messageId} gallery={gallery} /> : <ImageProgressCard job={job} />}
            </div>
          ))}
          {images.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} sessionId={sessionId} messageId={messageId} gallery={gallery} />
          ))}
        </div>
      ) : null}
      {others.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} sessionId={sessionId} messageId={messageId} />
      ))}
    </div>
  )
}

function ImageProgressCard({ job }: { job: ImageGenerationProgress }): JSX.Element {
  const t = useT()
  const phase = t(`artifact.imageStage.${job.stage}`)
  return (
    <section className="v3-artifact-card v3-image-progress" role="status" aria-label={phase} data-testid="image-generation-progress">
      <header className="v3-artifact-card-head">
        <Icon name="image" size={12} />
        <strong className="v3-artifact-card-name">{t('artifact.imageJob')}</strong>
        {job.model ? <span className="v3-artifact-card-meta">{job.model}</span> : null}
      </header>
      <div className="v3-artifact-image">
        {job.stage === 'error' ? <Notice tone="fail" compact>{job.detail || phase}</Notice> : (
          <span className="v3-image-progress-status"><TermSpinner variant="orbit" />{phase}</span>
        )}
      </div>
    </section>
  )
}

function artifactsFromSource(messages: readonly UIMessage[], sourceId: string): AssistantArtifact[] {
  const found: AssistantArtifact[] = []
  for (const message of messages) {
    if (!message.artifacts) continue
    for (const item of message.artifacts) if (item.sourceId === sourceId) found.push(item)
  }
  return found
}

function ArtifactCard({
  artifact,
  sessionId,
  messageId,
  gallery
}: {
  artifact: AssistantArtifact
  sessionId: string | null
  messageId: string | null
  gallery?: readonly ViewerImage[]
}): JSX.Element {
  const t = useT()
  const siblings = useStore(useShallow((s): AssistantArtifact[] => artifactsFromSource(s.messages, artifact.sourceId)))
  const versions = useMemo(() => artifactVersions(siblings, artifact), [siblings, artifact])
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
  const previous = versions[index - 1]
  const before = previous && !previous.unavailable && isImageArtifact(previous) ? filePreviewUrl(previous.path) : undefined
  const shownUrl = filePreviewUrl(shown.path)
  const shownGallery = gallery?.some((item) => item.src === shownUrl)
    ? gallery.map((item) => item.src === shownUrl ? { ...item, before } : item)
    : undefined
  return <ArtifactCardView key={shown.id} artifact={shown} sessionId={sessionId} messageId={messageId} versionBar={versionBar} before={before} gallery={shownGallery} />
}

function ArtifactCardView({
  artifact,
  sessionId,
  messageId,
  versionBar,
  before,
  gallery
}: {
  artifact: AssistantArtifact
  sessionId: string | null
  messageId: string | null
  versionBar: JSX.Element | null
  before?: string
  gallery?: readonly ViewerImage[]
}): JSX.Element {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const [showSource, setShowSource] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const textKey = artifactTextKey(artifact)
  const [text, setText] = useState<string | null>(() => artifact.unavailable || artifact.bytes <= 0 ? null : textCache.get(textKey) ?? null)
  const [readError, setReadError] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)

  const isHtml = useMemo(() => isHtmlArtifact(artifact), [artifact])
  const isImage = isImageArtifact(artifact)
  const isCode = artifact.kind === 'code' || isHtml
  const isVideo = !isImage && !isCode && previewFormatOf(artifact.filename) === 'video'
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
    const cached = textCache.get(textKey)
    setText(cached ?? null)
    setReadError(false)
    if (cached !== undefined) return undefined
    let alive = true
    void window.yan
      .readPreview(artifact.path)
      .then((result) => {
        if (result.ok && typeof result.text === 'string') {
          cacheArtifactText(textKey, result.text)
          if (alive) setText(result.text)
        } else if (alive) setReadError(true)
      })
      .catch(() => {
        if (alive) setReadError(true)
      })
    return () => {
      alive = false
    }
  }, [artifact.path, textKey, isCode, isHtml, showSource, unavailable])

  const reveal = (): void => {
    void window.yan.revealPath(openTarget).then((result) => {
      if (result?.ok === false && openTarget !== artifact.path) void window.yan.revealPath(artifact.path)
    })
  }

  const codeHidden = text ? Math.max(0, text.split('\n').length - CODE_PREVIEW_LINES) : 0
  const codeClamped = codeHidden > 0 && !codeOpen
  const shownCode = codeClamped && text ? text.split('\n').slice(0, CODE_PREVIEW_LINES).join('\n') : text
  const codeView = (body: string): JSX.Element => (
    <>
      <pre className="v3-artifact-code" data-clamped={codeClamped || undefined} data-testid="v3-artifact-code">
        <code>{body}</code>
      </pre>
      {codeHidden > 0 ? (
        <div className="v3-artifact-code-foot">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={codeOpen}
            data-testid="v3-artifact-code-toggle"
            onPress={() => setCodeOpen((open) => !open)}
          >
            {codeOpen ? t('artifact.codeLess') : t('artifact.codeMore', { n: codeHidden })}
          </Button>
          {codeOpen ? <span className="v3-artifact-code-hint">{t('artifact.codeScroll')}</span> : null}
        </div>
      ) : null}
    </>
  )

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
            <IconButton aria-label={t('artifact.previewHint')} tooltip={t('artifact.previewHint')} onPress={() => void previewFile(artifact.path)}>
              <Icon name="file" size={14} />
            </IconButton>
            <IconButton aria-label={t('artifact.revealHint')} tooltip={t('artifact.revealHint')} onPress={reveal}>
              <Icon name="folder" size={14} />
            </IconButton>
            <IconButton
              aria-label={t('artifact.copyPathHint')}
              tooltip={t('artifact.copyPathHint')}
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
            <button type="button" className="v3-artifact-image-open" aria-label={`${t('artifact.zoomHint')} · ${artifact.filename}`} onClick={() => setViewerOpen(true)}>
              <img src={filePreviewUrl(artifact.path)} alt={artifact.filename} loading="lazy" />
            </button>
          ) : (
            <Notice tone="fail" compact>{artifact.error || t('artifact.noPreview')}</Notice>
          )}
          <ImageViewer
            isOpen={viewerOpen}
            src={filePreviewUrl(artifact.path)}
            alt={artifact.filename}
            caption={artifact.description}
            before={before}
            gallery={gallery}
            onOpenChange={setViewerOpen}
          />
        </div>
      ) : null}

      {isHtml && !unavailable ? (
        showSource ? (
          codeView(readError ? t('artifact.htmlRead') : shownCode ?? t('artifact.reading'))
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
        codeView(unavailable ? artifact.error || t('artifact.noPreview') : readError ? t('artifact.htmlRead') : shownCode ?? t('artifact.reading'))
      ) : isImage ? null : isVideo && !unavailable ? (
        <video className="v3-artifact-video" src={filePreviewUrl(artifact.path)} controls preload="metadata" aria-label={artifact.filename} data-testid="v3-artifact-video" />
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

