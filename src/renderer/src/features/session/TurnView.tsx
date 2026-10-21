import { memo, useEffect, useState, type JSX } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useSessionText } from './text'
import { Markdown } from './Markdown'
import { TurnArtifacts } from './MessageParts'
import { ThinkingLine } from './Thinking'
import { ToolSteps } from './ToolSteps'
import { TurnProcess } from './TurnProcess'
import { conciseSegment, splitTurnProcess } from './turn-process'
import { showsThinking } from './transcript-view-model'
import { TranscriptViewScope } from './use-tool-run'
import { useTranscriptView } from '../../state/transcript-view'
import { approvalCallIds } from './tool-run-model'
import { MessageImage } from './Image'
import { UserText } from './UserText'
import { Icon } from './Icon'
import { Badge, IconButton, Notice } from '../../ui'
import { imageRefLabel, imageRefPrefix, referencedImageNumbers, stripImageLegend, usedImageRefPrefix } from '../composer/image-refs'
import { formatDuration } from '../../../../shared/duration'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import { forkAt, forkFromText } from '../../lib/fork'
import { forkTargetAfter } from './message-actions'
import { isSubagentNotice } from '../../../../shared/subagent-notice'
import { turnModelLabel } from './turn-model-label'
import { ErrorCard } from './ErrorCard'
import { LiveRunNotice } from './RunNotice'
import { CompactCommandEcho, CompactionMarker } from './CompactionMarker'
import { BranchSummary } from './BranchSummary'
import { SubagentLine } from './SubagentLine'
import type { TurnSubagentScope } from '../../state/subagent-view'
import { TurnChanges } from './TurnChanges'
import { compactionAnchorId, viewEdge } from './turn-lines'
import { BranchPager, type BranchPagerBinding } from './BranchPager'
import type { AssistantTurn, BashTurn, NoteTurn, Turn, UserTurn } from '../../../../shared/turns'

export const TurnView = memo(function TurnView({ turn, streaming, readOnly = false, sessionId = null, rewindOwner = null, branchPager, subagentScope }: { turn: Turn; streaming?: boolean; readOnly?: boolean; sessionId?: string | null; rewindOwner?: string | null; branchPager?: BranchPagerBinding; subagentScope?: TurnSubagentScope }): JSX.Element | null {
  if (turn.kind === 'user') return <UserTurnView turn={turn} readOnly={readOnly} rewindOwner={rewindOwner} branchPager={branchPager} />
  if (turn.kind === 'bash') return <BashTurnView turn={turn} />
  if (turn.kind === 'note') return <NoteTurnView turn={turn} sessionId={sessionId} />
  return <AssistantTurnView turn={turn} streaming={streaming} readOnly={readOnly} sessionId={sessionId} rewindOwner={rewindOwner} subagentScope={subagentScope} />
})

function UserTurnView({ turn, readOnly, rewindOwner, branchPager }: { turn: UserTurn; readOnly: boolean; rewindOwner: string | null; branchPager?: BranchPagerBinding }): JSX.Element | null {
  const t = useT()
  const { lang } = useI18n()
  const msg = turn.msg
  const checkpointId = useStore((s) => {
    if (readOnly || !msg.text || !rewindOwner) return null
    const owned = s.checkpoints.filter((record) => record.sessionKey === rewindOwner)
    return matchCheckpoint(owned, msg.text, msg.timestamp)?.id ?? null
  })
  const openRewind = useStore((s) => s.openRewind)
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
  const tt = useSessionText()
  const [copyState, setCopyState] = useCopyState()
  const pagerModel = msg.entryId ? branchPager?.models.get(msg.entryId) ?? null : null
  const checkpoint = checkpointId ? { id: checkpointId } : null
  if (isSubagentNotice(msg.text)) return null
  const displayText = stripImageLegend(msg.text ?? '')
  const refPrefix = usedImageRefPrefix(displayText) ?? imageRefPrefix(lang)
  const showImageRefs = (msg.images?.length ?? 0) > 1 || referencedImageNumbers(displayText).length > 0
  return (
    <article className="v3-msg user" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="v3-user-body">
        {msg.question ? (
          <Badge data-testid="v3-question-tag">
            <Icon name="message" size={12} />
            {t('chat.questionTag')}
          </Badge>
        ) : null}

        {msg.images?.length ? (
          <div className="v3-user-images">
            {msg.images.map((im, i) => (
              <div key={i} className="v3-user-image">
                {im.data ? <MessageImage src={`data:${im.mimeType};base64,${im.data}`} className="v3-img-thumb" /> :
                  im.url ? <MessageImage src={im.url} className="v3-img-thumb" /> :
                  <div className="v3-img-missing" title={t('chat.imageMissing')}><Icon name="image" size={12} /><span>{t('chat.imageMissing')}</span></div>}
                {showImageRefs ? <Badge tone="accent" className="v3-user-image-ref">{imageRefLabel(refPrefix, i + 1)}</Badge> : null}
              </div>
            ))}
          </div>
        ) : null}

        {msg.qa?.length ? (
          <div className="v3-qa" data-testid="v3-question-qa">
            {msg.qa.map((item, i) => (
              <div key={i} className="v3-qa-item">
                <div className="v3-qa-q">{item.question}</div>
                {item.answer ? <div className="v3-qa-a">{item.answer}</div> : null}
              </div>
            ))}
          </div>
        ) : msg.text ? (
          <div className="v3-bubble">
            <UserText text={displayText} />
          </div>
        ) : null}

        <div className="v3-msg-meta v3-user-actions" role="toolbar" aria-label={tt('msgActions')} data-testid="v3-user-actions">
          {pagerModel && branchPager ? (
            <BranchPager
              model={pagerModel}
              disabled={branchPager.disabled}
              pending={branchPager.pending !== null}
              error={branchPager.error}
              onNavigate={branchPager.onNavigate}
            />
          ) : null}
          {displayText ? (
            <IconButton
              className="v3-msg-btn"
              aria-label={copyState === 'copied' ? tt('msgCopied') : copyState === 'failed' ? tt('msgCopyFailed') : tt('msgCopy')}
              data-testid="v3-msg-copy"
              onPress={() => void navigator.clipboard.writeText(displayText).then(() => setCopyState('copied'), () => setCopyState('failed'))}
            >
              <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} />
            </IconButton>
          ) : null}
          {!readOnly && displayText ? (
            <IconButton className="v3-msg-btn" aria-label={tt('msgEdit')} data-testid="v3-msg-edit" onPress={() => insertIntoComposer(displayText)}>
              <Icon name="edit" size={14} />
            </IconButton>
          ) : null}
          {checkpoint ? (
            <IconButton className="v3-msg-btn" aria-label={t('chat.rewind')} onPress={() => openRewind(checkpoint.id, msg.text)} data-testid="v3-msg-rewind">
              <Icon name="back" size={14} />
            </IconButton>
          ) : null}
          {!readOnly && msg.text ? (
            <IconButton className="v3-msg-btn" aria-label={t('chat.fork')} data-testid="v3-msg-fork" onPress={() => void forkFromText(msg.text)}>
              <Icon name="branch" size={14} />
            </IconButton>
          ) : null}
          {msg.timestamp ? <TurnClock timestamp={msg.timestamp} /> : null}
        </div>
      </div>
    </article>
  )
}

function BashTurnView({ turn }: { turn: BashTurn }): JSX.Element {
  const t = useT()
  const msg = turn.msg
  return (
    <article className="v3-msg bash" data-msg-id={msg.id} data-turn-id={turn.id}>
      <Badge>{t('chat.bash')}</Badge>
      <ToolSteps tools={msg.toolCalls ?? []} />
      {msg.error ? <Notice tone="fail" compact>{msg.error}</Notice> : null}
    </article>
  )
}

function NoteTurnView({ turn, sessionId }: { turn: NoteTurn; sessionId: string | null }): JSX.Element {
  const t = useT()
  const msg = turn.msg
  const summary = msg.note?.kind === 'branchSummary'
  const label = summary ? t('chat.noteBranchSummary')
    : msg.note?.customType ? `${t('chat.noteCustom')} · ${msg.note.customType}` : t('chat.noteCustom')
  const head = (
    <>
      <Icon name={summary ? 'branch' : 'message'} size={13} />
      <span className="v3-note-label">{label}</span>
      {msg.timestamp ? <TurnClock timestamp={msg.timestamp} /> : null}
    </>
  )
  const body = (
    <div className="v3-note-body">
      {msg.text ? <div className="v3-para"><Markdown text={msg.text} sessionId={sessionId} messageId={msg.id} /></div> : null}
      {msg.images?.length ? (
        <div className="v3-note-images">
          {msg.images.map((im, i) =>
            im.data ? <MessageImage key={i} src={`data:${im.mimeType};base64,${im.data}`} className="v3-img-thumb" /> :
            im.url ? <MessageImage key={i} src={im.url} className="v3-img-thumb" /> : null
          )}
        </div>
      ) : null}
    </div>
  )
  return (
    <article className="v3-msg note" data-msg-id={msg.id} data-turn-id={turn.id} data-note={msg.note?.kind ?? 'custom'} data-testid="v3-note">
      {summary ? (
        <details className="v3-note">
          <summary className="v3-note-head">{head}</summary>
          {body}
        </details>
      ) : (
        <div className="v3-note">
          <div className="v3-note-head">{head}</div>
          {body}
        </div>
      )}
    </article>
  )
}

export function replyText(turn: AssistantTurn): string {
  const text = (turn.segments.length
    ? turn.segments.flatMap((segment) => segment.response ? [segment.response.text] : [])
    : [turn.response?.text ?? '']).join('\n\n').trim()
  return text
}

function AssistantTurnView({ turn: sourceTurn, streaming, readOnly, sessionId, rewindOwner, subagentScope }: { turn: AssistantTurn; streaming?: boolean; readOnly: boolean; sessionId: string | null; rewindOwner: string | null; subagentScope?: TurnSubagentScope }): JSX.Element | null {
  const view = useTranscriptView(sessionId)
  const concise = !showsThinking(view)
  const turn = concise ? { ...sourceTurn, segments: sourceTurn.segments.map(conciseSegment) } : sourceTurn
  const turnThinking = concise && !turn.thinkingLive ? '' : turn.thinking ?? ''
  const edgeFirst = useStore((s) => viewEdge(turn.sourceIds, s.messages, !!streaming).first)
  const edgeLast = useStore((s) => viewEdge(turn.sourceIds, s.messages, !!streaming).last)
  const showCompaction = useStore((s) => {
    if (s.session?.compaction) return edgeLast
    const anchor = compactionAnchorId(s.messages, s.session?.lastCompaction)
    return anchor !== null && turn.sourceIds.includes(anchor)
  })
  const approvals = useStore((s) => s.approvals)
  const approvalIds = streaming ? approvalCallIds(approvals, turn.tools, sessionId) : undefined
  const promoted = turn.response?.hasTools ? (turn.responseParts?.length ? turn.responseParts : [turn.response]) : []
  const commentary = promoted.length ? [...turn.commentary, ...promoted] : turn.commentary
  const liveImageProgress = turn.imageProgress.filter((item) => item.stage !== 'done')
  const hasBody = commentary.length > 0 || !!turn.response || turn.tools.length > 0 || !!turn.thinking || turn.artifacts.length > 0 || liveImageProgress.length > 0 || !!turn.error
  if (!hasBody && !streaming) return null
  const flow = flowSegments(turn, commentary)
  const split = flow ? splitTurnProcess(flow) : null
  const processSegs = split?.process ?? []
  const thinkingBySegment = processSegs.length > 0

  return (
    <TranscriptViewScope.Provider value={view}>
      <article className={`v3-msg assistant ${streaming ? 'streaming' : ''}`} data-turn-id={turn.id} data-tools={turn.tools.length} data-transcript-view={view}>
        <div className="v3-assistant-body">
          {edgeFirst ? <BranchSummary /> : null}
          {thinkingBySegment ? null : <ThinkingLine text={turnThinking} ms={turn.thinkingMs} live={turn.thinkingLive} />}
  
          {turn.error ? <ErrorCard sourceIds={turn.sourceIds} error={turn.error} /> : null}
  
          {split ? (
            <>
              {processSegs.length ? (
                <TurnProcess
                  process={processSegs}
                  live={!!streaming && !split.reply}
                  sessionId={sessionId}
                  turnId={turn.id}
                  approvalIds={approvalIds}
                />
              ) : null}
              {split.reply ? (
                <div className="v3-seg" data-testid="v3-seg">
                  <div className="v3-para">
                    <Markdown text={split.reply.response?.text ?? ''} sourceCwd={split.reply.response?.sourceCwd} live={!!streaming && split.reply.sourceMessageId === turn.sourceIds.at(-1)} sessionId={sessionId} messageId={split.reply.response?.id ?? split.reply.id} />
                  </div>
                </div>
              ) : null}
              {split.tail.map((seg, si) => {
                const last = si === split.tail.length - 1
                return (
                  <div key={seg.id} className="v3-seg" data-testid="v3-seg">
                    {thinkingBySegment ? <ThinkingLine text={seg.thinking} ms={seg.thinkingMs} live={seg.thinkingLive} /> : null}
                    {seg.commentary.length ? (
                      <div className="v3-commentary">
                        {seg.commentary.map((part, i) => (
                          <div key={part.id} className="v3-para dim">
                            <Markdown text={part.text} sourceCwd={part.sourceCwd} live={!!streaming && last && !seg.response && i === seg.commentary.length - 1} sessionId={sessionId} messageId={part.id} />
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <ToolSteps tools={seg.tools} approvalIds={approvalIds} />
                    {seg.response ? (
                      <div className="v3-para">
                        <Markdown text={seg.response.text} sourceCwd={seg.response.sourceCwd} live={!!streaming && seg.sourceMessageId === turn.sourceIds.at(-1)} sessionId={sessionId} messageId={seg.response.id} />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </>
          ) : (
            <>
              {commentary.length ? (
                <div className="v3-commentary">
                  {commentary.map((part, i) => (
                    <div key={part.id} className="v3-para dim">
                      <Markdown text={part.text} sourceCwd={part.sourceCwd} live={!!streaming && i === commentary.length - 1} sessionId={sessionId} messageId={part.id} />
                    </div>
                  ))}
                </div>
              ) : null}
              {turn.segments.length
                ? turn.segments.map((segment) => segment.response ? (
                    <div key={segment.id} className="v3-para">
                      <Markdown text={segment.response.text} sourceCwd={segment.response.sourceCwd} live={!!streaming && segment.sourceMessageId === turn.sourceIds.at(-1)} sessionId={sessionId} messageId={segment.response.id} />
                    </div>
                  ) : null)
                : turn.response && !turn.response.hasTools
                  ? <div className="v3-para"><Markdown text={turn.response.text} sourceCwd={turn.response.sourceCwd} live={!!streaming} sessionId={sessionId} messageId={turn.response.id} /></div>
                  : null}
              <ToolSteps tools={turn.tools} approvalIds={approvalIds} />
            </>
          )}
  
          {turn.artifacts.length ? <TurnArtifacts artifacts={turn.artifacts} sessionId={sessionId} messageId={turn.id} /> : null}
          {liveImageProgress.length ? <ImageProgressFallbackNote /> : null}
  
          <SubagentLine turn={turn} scope={subagentScope} />
  
          {streaming ? <LiveRunNotice /> : null}
          {streaming && !turn.response && !commentary.length && !turn.tools.length && !turn.thinking ? <span className="v3-caret" aria-hidden>▍</span> : null}
          {!streaming ? <TurnChanges turn={sourceTurn} readOnly={readOnly} rewindOwner={rewindOwner} /> : null}
          {!streaming ? <TurnMeta turn={sourceTurn} readOnly={readOnly} /> : null}
          {showCompaction ? <CompactCommandEcho /> : null}
          {showCompaction ? <CompactionMarker /> : null}
        </div>
      </article>
    </TranscriptViewScope.Provider>
  )
}

function flowSegments(turn: AssistantTurn, commentary: readonly { id: string }[]): AssistantTurn['segments'] | null {
  if (!turn.segments.length) return null
  const toolCount = turn.segments.reduce((sum, seg) => sum + seg.tools.length, 0)
  if (toolCount !== turn.tools.length) return null
  const covered = new Set<string>()
  for (const seg of turn.segments) {
    for (const part of seg.commentary) covered.add(part.id)
    if (seg.response) covered.add(seg.response.id)
  }
  if (commentary.some((part) => !covered.has(part.id))) return null
  if (turn.response && !turn.response.hasTools && !covered.has(turn.response.id)) return null
  return turn.segments
}

function ImageProgressFallbackNote(): JSX.Element {
  const tt = useSessionText()
  return (
    <Notice compact className="v3-fallback-note" role="note" icon={<Icon name="layers" size={13} />} data-testid="v3-image-progress-fallback">{tt('imageProgress')}</Notice>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'

function useCopyState(): [CopyState, (next: CopyState) => void] {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  useEffect(() => {
    if (copyState === 'idle') return undefined
    const timer = window.setTimeout(() => setCopyState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [copyState])
  return [copyState, setCopyState]
}

async function forkAfterTurn(sourceIds: readonly string[]): Promise<void> {
  const state = useStore.getState()
  const target = forkTargetAfter(state.messages, sourceIds, isSubagentNotice)
  if (!target) {
    await state.clone()
    return
  }
  if (target.entryId) await forkAt(target.entryId)
  else await forkFromText(target.text)
}

function TurnMeta({ turn, readOnly }: { turn: AssistantTurn; readOnly: boolean }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const models = useStore((s) => s.models)
  const busy = useStore((s) => !!(s.session?.isAgentRunning || s.session?.isStreaming || s.session?.isCompacting))
  const [copyState, setCopyState] = useCopyState()
  const reply = replyText(turn)
  const elapsed = turn.elapsedMs && turn.elapsedMs > 0 ? formatDuration(turn.elapsedMs) : null
  const modelDisplay = turn.model ? turnModelLabel(turn.model, models) : null
  const stopLabel = turn.terminalReason === 'stopped' ? t('act.stopped') : turn.terminalReason === 'interrupted' ? t('act.interrupted') : null
  if (!reply && !turn.timestamp && !elapsed && !turn.model) return null
  return (
    <div className="v3-msg-meta" data-testid="v3-turn-meta">
      {turn.timestamp ? <TurnClock timestamp={turn.timestamp} /> : null}
      {modelDisplay ? <span className="v3-act-model" title={modelDisplay.identity}>{modelDisplay.label}</span> : null}
      {stopLabel ? <span className="v3-msg-meta-stop">{stopLabel}</span> : null}
      {elapsed ? <span className="v3-act-time" title={turn.waitMs ? t('tok.elapsedWaitTip', { n: formatDuration(turn.waitMs) }) : t('tok.elapsedTip')}>{elapsed}</span> : null}
      {reply && !readOnly ? (
        <IconButton
          aria-label={t(copyState === 'copied' ? 'turn.copied' : copyState === 'failed' ? 'turn.copyFailed' : 'turn.copy')}
          data-testid="v3-turn-copy"
          isDisabled={turn.streaming}
          onPress={() => void navigator.clipboard.writeText(reply).then(() => setCopyState('copied'), () => setCopyState('failed'))}
        >
          <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} />
        </IconButton>
      ) : null}
      {!readOnly && turn.sourceIds.length ? (
        <IconButton
          aria-label={tt('turnForkTip')}
          data-testid="v3-turn-fork"
          isDisabled={turn.streaming || busy}
          onPress={() => void forkAfterTurn(turn.sourceIds)}
        >
          <Icon name="branch" size={14} />
        </IconButton>
      ) : null}
    </div>
  )
}

let clockFormats: { clock: Intl.DateTimeFormat; full: Intl.DateTimeFormat } | null = null

function turnClockFormats(): { clock: Intl.DateTimeFormat; full: Intl.DateTimeFormat } {
  clockFormats ??= {
    clock: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }),
    full: new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    })
  }
  return clockFormats
}

export function TurnClock({ timestamp }: { timestamp: number }): JSX.Element | null {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return null
  const formats = turnClockFormats()
  const clock = formats.clock.format(date)
  const full = formats.full.format(date)
  return <time className="v3-time" dateTime={date.toISOString()} title={full} aria-label={full}>{clock}</time>
}
