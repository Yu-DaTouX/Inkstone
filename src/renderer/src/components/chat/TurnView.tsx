import { memo, useEffect, useId, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { forkFromText } from '../../lib/fork'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import { InteractionPart } from '../../lib/interaction-state'
import { Markdown } from './MessageParts'
import { ToolGroup } from './ToolRow'
import { TurnActivityLine, TurnClock, TurnMeta, TurnProcess } from './TurnProcess'
import { ReasoningCapsule } from './Reasoning'
import { TurnSubagents } from './TurnSubagents'
import { isSubagentNotice } from '../../../../shared/subagent-notice'
import type { AssistantTurn, BashTurn, Turn, UserTurn } from '../../../../shared/turns'
import { formatDuration } from '../../../../shared/duration'
import { fileUrl as toFileUrl } from '../../../../shared/file-url'
import { Caret, IconButton, Segmented } from '../ui'
import { ChatImage } from './ChatImage'
import { HtmlArtifactPreview } from './HtmlArtifactPreview'
import { isHtmlArtifact } from '../../../../shared/html-artifact-preview'
import { isQuotaWaitError } from '../../../../shared/quota-resume'
import { QuotaResumeAction } from './QuotaResumeAction'

export const TurnView = memo(function TurnView({ turn, streaming, readOnly = false }: { turn: Turn; streaming?: boolean; readOnly?: boolean }) {
  if (turn.kind === 'user') return <UserTurnView turn={turn} readOnly={readOnly} />
  if (turn.kind === 'bash') return <BashTurnView turn={turn} />
  return <AssistantTurnView turn={turn} streaming={streaming} readOnly={readOnly} />
})

function UserTurnView({ turn, readOnly }: { turn: UserTurn; readOnly: boolean }) {
  const t = useT()
  const msg = turn.msg
  const checkpoints = useStore((s) => s.checkpoints)
  const openRewind = useStore((s) => s.openRewind)
  const checkpoint = !readOnly && msg.text ? matchCheckpoint(checkpoints, msg.text, msg.timestamp) : null
  if (isSubagentNotice(msg.text)) return null

  return (
    <article className="msg user" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="gutter">
        <span className="gutter-prompt">❯</span>
      </div>
      <div className="msg-body">
        {msg.question ? (
          <div className="msg-label">
            <span className="msg-tag question" data-testid="msg-question-tag" title={t('chat.questionTag')}>
              <Icon name="message-dots" size={12} />
              {t('chat.questionTag')}
            </span>
          </div>
        ) : null}

        {msg.images?.length ? (
          <div className="msg-images">
            {msg.images.map((im, i) =>
              im.data ? (
                <ChatImage key={i} src={`data:${im.mimeType};base64,${im.data}`} />
              ) : im.url ? (
                <ChatImage key={i} src={im.url} />
              ) : (
                <div key={i} className="msg-image-missing" title={t('chat.imageMissing')}>
                  <Icon name="image" size={12} />
                  <span>{t('chat.imageMissing')}</span>
                </div>
              )
            )}
          </div>
        ) : null}

        {msg.qa?.length ? (
          <div className="qa-list" data-testid="msg-question-qa">
            {msg.qa.map((item, i) => (
              <div key={i} className="qa-item">
                <details className="qa-q">
                  <summary>{item.question}</summary>
                </details>
                {item.answer ? <div className="qa-a">{item.answer}</div> : null}
              </div>
            ))}
          </div>
        ) : msg.text ? (
          <div className="bubble">
            <span className="bubble-prompt" aria-hidden>
              ›
            </span>
            <span className="bubble-text">{msg.text}</span>
          </div>
        ) : null}
        <div className="turn-footer msg-meta">
          {msg.timestamp ? <TurnClock timestamp={msg.timestamp} /> : null}
          {!readOnly ? <button
            className="msg-act"
            title={t('chat.forkHere')}
            onClick={() => void forkFromText(msg.text)}
          >
            <Icon name="branch" size={12} />
            {t('chat.fork')}
          </button> : null}
          {checkpoint ? <button
            className="msg-act"
            title={t('chat.rewindHere')}
            onClick={() => openRewind(checkpoint.id, msg.text)}
            data-testid="msg-rewind"
          >
            <Icon name="back" size={12} />
            {t('chat.rewind')}
          </button> : null}
        </div>
      </div>
    </article>
  )
}

function BashTurnView({ turn }: { turn: BashTurn }) {
  const t = useT()
  const msg = turn.msg

  return (
    <article className="msg bash" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="gutter">
        <span className="gutter-prompt">$</span>
      </div>
      <div className="msg-body">
        <div className="msg-label">
          <span>{t('chat.bash')}</span>
        </div>
        <ToolGroup tools={msg.toolCalls ?? []} />
        {msg.error ? (
          <div className="msg-error">
            <Icon name="alert-circle" size={12} />
            <span>{msg.error}</span>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function AssistantTurnView({ turn, streaming, readOnly }: { turn: AssistantTurn; streaming?: boolean; readOnly: boolean }) {
  const lastMessageId = useStore((s) => s.messages.at(-1)?.id)
  const canResume = !readOnly && !streaming && !!turn.error && !!lastMessageId && turn.sourceIds.includes(lastMessageId) && isQuotaWaitError(turn.error)
  const sideProcess = useStore((s) => s.settings?.processLayout === 'side' || s.settings?.processLayout === 'left')
  const topThinking = useStore((s) => s.settings?.liveThinking === true && !(s.settings.processLayout === 'side' || s.settings.processLayout === 'left')) && !!turn.thinking
  const visibleImageProgress = turn.imageProgress.filter((item) => item.stage !== 'done')
  const promotedProgress = turn.response?.hasTools
    ? (turn.responseParts?.length ? turn.responseParts : [turn.response])
    : []
  const commentary = promotedProgress.length
    ? [...turn.commentary, ...promotedProgress]
    : turn.commentary
  const segmented = turn.segments.length > 0
  const hasBody =
    turn.commentary.length > 0 ||
    !!turn.response ||
    turn.tools.length > 0 ||
    !!turn.thinking ||
    turn.artifacts.length > 0 ||
    visibleImageProgress.length > 0 ||
    !!turn.error
  if (!hasBody && !streaming) return null

  return (
    <article
      className={`msg assistant ${streaming ? 'streaming' : ''}`}
      data-msg-id={turn.id}
      data-turn-id={turn.id}
      data-tools={turn.tools.length}
    >
      <div className="gutter">
        <Icon name="sparkles" size={12} />
      </div>
      <div className="msg-body">
        <div className="turn-main">
        <TurnActivityLine turn={turn} streaming={streaming} />
        {topThinking ? (
          <div className="turn-reason">
            <ReasoningCapsule text={turn.thinking ?? ''} ms={turn.thinkingMs} live={turn.thinkingLive} turnLive={streaming} defaultOpen />
          </div>
        ) : null}
        {!sideProcess ? <TurnProcess turn={turn} streaming={streaming} hideReasoning={topThinking} /> : null}
        {turn.error ? (
          <div className="msg-error" role="alert">
            <Icon name="alert-circle" size={12} />
            <span>{turn.error}</span>
            {canResume ? <QuotaResumeAction /> : null}
          </div>
        ) : null}
        {visibleImageProgress.length ? <ImageProgressList items={visibleImageProgress} /> : null}
        {commentary.length ? <CommentaryList parts={commentary} liveSourceId={streaming ? turn.sourceIds.at(-1) : undefined} /> : null}

        {!readOnly ? <TurnSubagents turn={turn} /> : null}

        {segmented
          ? turn.segments.map((segment) => (
              segment.response ? <TurnResponse key={segment.id} response={segment.response} parts={segment.responseParts} live={!!streaming && segment.sourceMessageId === turn.sourceIds.at(-1)} /> : null
            ))
          : turn.response && !turn.response.hasTools
            ? <TurnResponse response={turn.response} parts={turn.responseParts} live={!!streaming} />
            : null}


        {turn.artifacts.length ? <TurnArtifacts artifacts={turn.artifacts} /> : null}

        {streaming && !turn.response && !commentary.length && !turn.tools.length && !turn.thinking ? (
          <Caret idle className="cursor" />
        ) : null}
        {!streaming ? <TurnMeta turn={turn} /> : null}
        </div>
        {sideProcess ? <TurnProcess turn={turn} streaming={streaming} hideReasoning={topThinking} /> : null}
      </div>
    </article>
  )
}

function TurnResponse({
  response,
  parts,
  live = false
}: {
  response: NonNullable<AssistantTurn['response']>
  parts?: AssistantTurn['responseParts']
  live?: boolean
}) {
  return (
    <div className="turn-response" data-testid="turn-response">
      {parts?.length
        ? parts.map((part, index) => <Paragraph key={part.id} partId={part.id} text={part.text} sourceCwd={part.sourceCwd} primary live={live && index === parts.length - 1} />)
        : <Paragraph partId={response.id} text={response.text} sourceCwd={response.sourceCwd} primary live={live} />}
    </div>
  )
}

type TurnArtifact = AssistantTurn['artifacts'][number]

const isGridImage = (artifact: TurnArtifact): boolean => artifact.previewable && (artifact.kind === 'image' || artifact.kind === 'svg')

function TurnArtifacts({ artifacts }: { artifacts: TurnArtifact[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const groupId = useId()
  const images = artifacts.filter(isGridImage)
  const others = artifacts.filter((artifact) => !isGridImage(artifact))
  const attached = images.filter((artifact) => !artifact.provider)
  const primary = attached.length && attached.length < images.length ? attached : images
  const process = images.filter((artifact) => !primary.includes(artifact))
  const grid = (items: TurnArtifact[]) => (
    <div className={`turn-artifact-grid${items.length > 1 ? ' multi' : ''}`}>
      {items.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
    </div>
  )
  return (
    <div className="turn-artifacts" data-testid="turn-artifacts">
      {primary.length ? grid(primary) : null}
      {process.length ? (
        <div className="turn-artifact-process">
          <button
            className="turn-progress-toggle"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={groupId}
            data-testid="turn-artifact-process-toggle"
          >
            <Icon name="chevron-right" size={12} className="chev" />
            <span>{t('artifact.processImages', { n: process.length })}</span>
          </button>
          <div id={groupId} className="turn-progress-body" hidden={!open}>
            {open ? grid(process) : null}
          </div>
        </div>
      ) : null}
      {others.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
    </div>
  )
}

function ArtifactCard({ artifact }: { artifact: TurnArtifact }) {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const [text, setText] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [htmlMode, setHtmlMode] = useState<'page' | 'source'>('page')
  const [htmlExpanded, setHtmlExpanded] = useState(false)
  const [htmlReload, setHtmlReload] = useState(0)
  const fileUrl = toFileUrl(artifact.path)
  const openTarget = artifact.sourcePath ?? artifact.path
  const reveal = async (): Promise<void> => {
    const result = await window.yan.revealPath(openTarget)
    if (result?.ok === false && openTarget !== artifact.path) await window.yan.revealPath(artifact.path)
  }
  const isHtml = isHtmlArtifact(artifact)
  const isCode = artifact.kind === 'code' || isHtml
  const isImage = artifact.kind === 'image' || artifact.kind === 'svg'
  const unavailable = artifact.unavailable === true || artifact.bytes <= 0
  const readSource = isCode && (!isHtml || htmlMode === 'source')

  useEffect(() => {
    let alive = true
    setText(null)
    setReadError(false)
    setTruncated(false)
    if (!readSource || unavailable) return () => { alive = false }
    void window.yan.readPreview(artifact.path).then((result) => {
      if (!alive) return
      if (result.ok && typeof result.text === 'string') {
        setText(result.text)
        setTruncated(result.truncated === true)
      } else setReadError(true)
    }).catch(() => { if (alive) setReadError(true) })
    return () => { alive = false }
  }, [artifact.path, artifact.bytes, readSource, unavailable])

  return (
    <section
      className="artifact-card"
      role="group"
      aria-label={artifact.filename}
      data-artifact-id={artifact.id}
      onClick={(e) => { if (!unavailable && !(e.target as HTMLElement).closest('a,button')) void previewFile(artifact.path) }}
      onDoubleClick={(e) => { if (!unavailable && !(e.target as HTMLElement).closest('a,button')) void reveal() }}
      tabIndex={unavailable ? undefined : 0}
      onKeyDown={(event) => {
        if (unavailable || event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void previewFile(artifact.path)
        }
      }}
      title={unavailable ? undefined : t('artifact.cardHint')}
    >
      <div className="artifact-head">
        <Icon name={artifact.kind === 'image' || artifact.kind === 'svg' ? 'sparkles' : 'file'} size={12} />
        <strong title={artifact.description}>{artifact.filename}</strong>
        <span className="artifact-meta">{fmtArtifactBytes(artifact.bytes)}</span>
        {artifact.provider ? <span className="artifact-provider">{artifact.provider}{artifact.model ? ` · ${artifact.model}` : ''}</span> : null}
        <span className="spacer" />
        {isHtml && !unavailable ? <Segmented
          size="sm"
          label={t('artifact.htmlMode')}
          value={htmlMode}
          onChange={setHtmlMode}
          options={[
            { value: 'page', label: t('artifact.htmlPage') },
            { value: 'source', label: t('artifact.htmlSource') }
          ]}
          testId="artifact-html-mode"
        /> : null}
        {isHtml && !unavailable && htmlMode === 'page' ? <>
          <IconButton size="sm" icon="refresh" label={t('artifact.htmlReload')} title={`${t('artifact.htmlReload')} · ${t('artifact.htmlHint')}`} onClick={() => setHtmlReload((n) => n + 1)} data-testid="artifact-html-reload" />
          <IconButton size="sm" icon={htmlExpanded ? 'minus' : 'maximize'} label={htmlExpanded ? t('artifact.htmlCollapse') : t('artifact.htmlExpand')} active={htmlExpanded} onClick={() => setHtmlExpanded((v) => !v)} data-testid="artifact-html-expand" />
        </> : null}
        {!unavailable ? <span className="artifact-actions">
          <IconButton size="sm" icon="sidebar-right" label={t('artifact.previewHint')} onClick={() => void previewFile(artifact.path)} />
          <IconButton size="sm" icon="folder-open" label={t('artifact.revealHint')} onClick={() => void reveal()} />
          <IconButton size="sm" icon="copy" label={t('artifact.copyPathHint')} onClick={() => void navigator.clipboard.writeText(openTarget)} />
        </span> : null}
      </div>
      {artifact.description && !isImage ? <ArtifactDescription text={artifact.description} /> : null}
      {artifact.previewable && isImage ? (
        <div className={`artifact-image-wrap ${unavailable ? 'failed' : ''}`}>
          {!unavailable ? (
            <img
              src={fileUrl}
              alt={artifact.filename}
              className="artifact-image"
              title={t('artifact.zoomHint')}
              onLoad={(event) => {
                const image = event.currentTarget
                if (image.naturalWidth <= 64 && image.naturalHeight <= 64) image.classList.add('pixel')
              }}
              onError={(event) => {
                event.currentTarget.hidden = true
                event.currentTarget.parentElement?.classList.add('failed')
              }}
            />
          ) : null}
          {unavailable ? <span className="artifact-preview-error">{artifact.error || t('artifact.noPreview')}</span> : null}
        </div>
      ) : null}
      {artifact.description && isImage ? <ArtifactDescription text={artifact.description} /> : null}
      {isHtml && !unavailable && htmlMode === 'page'
        ? <HtmlArtifactPreview key={artifact.path} path={artifact.path} filename={artifact.filename} expanded={htmlExpanded} reloadToken={htmlReload} />
        : isCode ? <>
          <pre className="artifact-code"><code>{unavailable ? (artifact.error || t('artifact.noPreview')) : readError ? t('artifact.htmlRead') : text ?? t('artifact.reading')}</code></pre>
          {isHtml && truncated ? <div className="artifact-binary">{t('artifact.sourceTruncated')}</div> : null}
        </> : null}
      {!artifact.previewable && !isHtml ? <div className="artifact-binary">{unavailable ? (artifact.error || t('artifact.unavailable')) : t('artifact.binary')}</div> : null}
    </section>
  )
}

function ArtifactDescription({ text }: { text: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const long = text.length > 90
  return (
    <div className="artifact-description">
      <div className={`artifact-description-text${long && !open ? ' clamp' : ''}`}>{text}</div>
      {long ? (
        <button type="button" className="artifact-description-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('artifact.descLess') : t('artifact.descMore')}
        </button>
      ) : null}
    </div>
  )
}

function ImageProgressList({ items }: { items: AssistantTurn['imageProgress'] }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  const active = items.some((item) => item.stage !== 'done' && item.stage !== 'error')

  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [active])

  return (
    <div className="image-progress-list" data-testid="image-progress-list">
      {items.map((item) => {
        const running = item.stage !== 'done' && item.stage !== 'error'
        const elapsed = Math.max(0, (item.endedAt ?? now) - item.startedAt)
        return (
          <div className={`image-progress ${running ? 'running' : ''} ${item.stage === 'error' ? 'failed' : ''}`} key={item.id} data-stage={item.stage}>
            <div className="image-progress-head">
              <Icon name={item.stage === 'error' ? 'alert-circle' : 'sparkles'} size={12} />
              <strong>{t('artifact.imageGen')}</strong>
              <span className="image-progress-stage">{t(IMAGE_STAGE[item.stage])}</span>
              <span className="spacer" />
              <span className="image-progress-time">{formatDuration(elapsed)}</span>
            </div>
            <div className="image-progress-track" aria-hidden="true"><span /></div>
            {item.detail ? <div className="image-progress-detail">{item.detail}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

const IMAGE_STAGE: Record<AssistantTurn['imageProgress'][number]['stage'], MessageKey> = {
  queued: 'artifact.stage.queued',
  preparing: 'artifact.stage.preparing',
  confirming: 'artifact.stage.confirming',
  requesting: 'artifact.stage.requesting',
  generating: 'artifact.stage.generating',
  saving: 'artifact.stage.saving',
  done: 'artifact.stage.done',
  error: 'artifact.stage.error'
}

function fmtArtifactBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function ParagraphImpl({ text, primary, sourceCwd, live, partId }: { text: string; primary?: boolean; sourceCwd?: string; live?: boolean; partId?: string }) {
  return (
    <div className={`turn-para ${primary ? 'primary' : ''}`}>
      <InteractionPart.Provider value={partId ?? ''}><Markdown text={text} sourceCwd={sourceCwd} live={live} /></InteractionPart.Provider>
    </div>
  )
}

const Paragraph = memo(
  ParagraphImpl,
  (a, b) => a.text === b.text && a.primary === b.primary && a.sourceCwd === b.sourceCwd && a.live === b.live && a.partId === b.partId
)

const PROGRESS_KEEP = 3
function compactProgressCount(parts: readonly { text: string }[]): number {
  return Math.max(0, parts.length - PROGRESS_KEEP)
}

function CommentaryList({ parts, liveSourceId }: { parts: readonly AssistantTurn['commentary'][number][]; liveSourceId?: string }) {
  const t = useT()
  const groupId = useId()
  const [open, setOpen] = useState(false)
  const compactCount = compactProgressCount(parts)
  return (
    <div className="turn-commentary" data-testid="turn-commentary">
      {compactCount > 0 ? (
        <>
          <button
            className="turn-progress-toggle"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={groupId}
            data-testid="turn-progress-toggle"
          >
            <Icon name="chevron-right" size={12} className="chev" />
            <span>{t('turn.previousProgress', { n: compactCount })}</span>
          </button>
          <div id={groupId} className="turn-progress-body" hidden={!open}>
            {open ? parts.slice(0, compactCount).map((p) => (
              <Paragraph key={p.id} partId={p.id} text={p.text} sourceCwd={p.sourceCwd} />
            )) : null}
          </div>
        </>
      ) : null}
      {parts.slice(compactCount).map((p, index, visible) => (
        <Paragraph key={p.id} partId={p.id} text={p.text} sourceCwd={p.sourceCwd} live={!!liveSourceId && p.id.startsWith(liveSourceId + '#') && index === visible.length - 1} />
      ))}
    </div>
  )
}
