import { memo, useEffect, useId, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { forkFromText } from '../../lib/fork'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import { Markdown } from './MessageParts'
import { ToolGroup } from './ToolRow'
import { TurnActivityLine, TurnClock, TurnMeta, TurnProcess } from './TurnProcess'
import { ReasoningCapsule, useTypewriter } from './Reasoning'
import { TurnSubagents } from './TurnSubagents'
import { isSubagentNotice } from '../../../../shared/subagent-notice'
import type { AssistantTurn, BashTurn, Turn, UserTurn } from '../../../../shared/turns'
import { formatDuration } from '../../../../shared/duration'
import { fileUrl as toFileUrl } from '../../../../shared/file-url'
import { Caret, IconButton, Segmented } from '../ui'
import { ChatImage } from './ChatImage'
import { HtmlArtifactPreview } from './HtmlArtifactPreview'
import { isHtmlArtifact } from '../../../../shared/html-artifact-preview'

/**
 * 回合视图 —— 把「一轮对话」渲染成**一块**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（用户报的问题）
 * ══════════════════════════════════════════════════════════════════
 * 「ai 发送的消息要进行合并」——
 * pi 的协议是「每次 API 往返 = 一条 assistant 消息」，所以一个带工具的回合
 * 会产生很多条。实测一个真实会话里**最长 34 条连续 assistant 消息**，
 * 界面上就是 34 个独立的「砚」块，各带一个符号槽。读起来全是碎片，
 * 而它们其实是同一个回答。
 *
 * 现在：一轮 = 一块「砚」 + 一个整轮活动摘要 + 一串**段落**。
 *
 * 「每次发送的信息要根据段落来显示」——
 * AI 一次吐好几段（解释 + 清单 + 结论）时，合成一个死长的 <p> 是一坨。
 * 现在每段是一个 <p>，段间有间距、新到的段各自淡入
 * （见 chat.css 的 `.turn-para`）。
 */

export const TurnView = memo(function TurnView({ turn, streaming, readOnly = false }: { turn: Turn; streaming?: boolean; readOnly?: boolean }) {
  if (turn.kind === 'user') return <UserTurnView turn={turn} readOnly={readOnly} />
  if (turn.kind === 'bash') return <BashTurnView turn={turn} />
  return <AssistantTurnView turn={turn} streaming={streaming} readOnly={readOnly} />
})

/* ------------------------------------------------------------------ 用户 */

function UserTurnView({ turn, readOnly }: { turn: UserTurn; readOnly: boolean }) {
  const t = useT()
  const msg = turn.msg
  const checkpoints = useStore((s) => s.checkpoints)
  const openRewind = useStore((s) => s.openRewind)
  /* 这一轮发出之前存过项目文件的快照 → 可以把代码回退到那个时刻 */
  const checkpoint = !readOnly && msg.text ? matchCheckpoint(checkpoints, msg.text, msg.timestamp) : null
  if (isSubagentNotice(msg.text)) return null

  return (
    <article className="msg user" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="gutter">
        <span className="gutter-prompt">❯</span>
      </div>
      <div className="msg-body">
        {/*
         * 「提问」标记：这条用户消息是问题面板的回答，不是手打的。
         * 问答只存在于工具结果里，不标出来回看时容易当成自己当时真的发了这些字。
         * 身份不用「你」标签表达：块首的 `›` 提示符就是身份（设计规范 §3.5）。
         */}
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
                /* 历史里的图：已落盘，直接读文件（重启后也看得到）；点开进右栏预览 */
                <ChatImage key={i} src={im.url} />
              ) : (
                /*
                 * 历史回放时图片数据被体积保护丢掉了（见 state/keep-images.ts）。
                 * 摆一个「图片未载入」而不是整个不渲染 —— 后者看起来就像这条
                 * 消息压根没贴过图。
                 */
                <div key={i} className="msg-image-missing" title={t('chat.imageMissing')}>
                  <Icon name="image" size={12} />
                  <span>{t('chat.imageMissing')}</span>
                </div>
              )
            )}
          </div>
        ) : null}

        {msg.text ? (
          <div className="bubble">
            <span className="bubble-prompt" aria-hidden>
              ›
            </span>
            <span className="bubble-text">{msg.text}</span>
          </div>
        ) : null}
        {/* 消息块下方一行：时间 + 从这里分支。悬停 / 聚焦时才完全显现，平时淡显。 */}
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

/* -------------------------------------------------------- 用户执行的 ! 命令 */

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
        {/* 用户主动跑的命令（`!命令`）—— 用同一套 Codex 风格行 */}
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

/* ------------------------------------------------------------------ 助手 */

function AssistantTurnView({ turn, streaming, readOnly }: { turn: AssistantTurn; streaming?: boolean; readOnly: boolean }) {
  /*
   * 成功进度只是过程状态：artifact 已经落盘后，用户需要看到的是最终文件，
   * 不是一张永远停在「已完成」的进度卡。失败则保留，方便解释原因并重试。
   * 进度数据仍留在回合模型里，历史 / 调试不会丢失，只是不再占用消息流。
   */
  /* 实时显示思考链：思考发生在回答之前，所以放在回合顶部、活动行之下；并列栏里仍留在栏中 */
  const sideProcess = useStore((s) => s.settings?.processLayout === 'side' || s.settings?.processLayout === 'left')
  const topThinking = useStore((s) => s.settings?.liveThinking === true && !(s.settings.processLayout === 'side' || s.settings.processLayout === 'left')) && !!turn.thinking
  const visibleImageProgress = turn.imageProgress.filter((item) => item.stage !== 'done')
  /* 末尾只有带工具的文字时，聚合层会把最后一条临时提升为 response。
     展示层仍把它接在其余非正式输出后面，避免正在执行时断成两种正文。 */
  const promotedProgress = turn.response?.hasTools
    ? (turn.responseParts?.length ? turn.responseParts : [turn.response])
    : []
  const commentary = promotedProgress.length
    ? [...turn.commentary, ...promotedProgress]
    : turn.commentary
  /* 多段正式回复各自保留来源；中间解说汇成同一块，过程记录统一放在下方。 */
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
        {/* 活动行：固定在回合顶部，状态原地更新（运行 / 待批准 / 完成 / 失败 / 停止） */}
        <TurnActivityLine turn={turn} streaming={streaming} />
        {topThinking ? (
          <div className="turn-reason">
            <ReasoningCapsule text={turn.thinking ?? ''} ms={turn.thinkingMs} live={turn.thinkingLive} turnLive={streaming} defaultOpen />
          </div>
        ) : null}
        {/* 过程（推理 + 工具）：正文上方，只出现一处；并列布局时由样式放到侧栏 */}
        {!sideProcess ? <TurnProcess turn={turn} streaming={streaming} hideReasoning={topThinking} /> : null}
        {/* 失败是首要信息：直接放在正文前面 */}
        {turn.error ? (
          <div className="msg-error" role="alert">
            <Icon name="alert-circle" size={12} />
            <span>{turn.error}</span>
          </div>
        ) : null}
        {visibleImageProgress.length ? <ImageProgressList items={visibleImageProgress} /> : null}
        {/* 同一回合的非正式输出连续阅读；短进展折叠也只出现一次。 */}
        {commentary.length ? <CommentaryList parts={commentary} liveSourceId={streaming ? turn.sourceIds.at(-1) : undefined} /> : null}

        {/* 这一回合派出的子代理：一个一行，运行中显示模型与最新动作 */}
        {!readOnly ? <TurnSubagents turn={turn} /> : null}

        {/* 正式回复仍逐段保留，避免自主续跑时把不同来源的正文拼成一段。 */}
        {segmented
          ? turn.segments.map((segment) => (
              segment.response ? <TurnResponse key={segment.id} response={segment.response} parts={segment.responseParts} live={!!streaming && segment.sourceMessageId === turn.sourceIds.at(-1)} /> : null
            ))
          : turn.response && !turn.response.hasTools
            ? <TurnResponse response={turn.response} parts={turn.responseParts} live={!!streaming} />
            : null}


        {turn.artifacts.length ? (
          <div className="turn-artifacts" data-testid="turn-artifacts">
            {turn.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
          </div>
        ) : null}

        {/* 刚开始、什么都还没有时给个光标：还没有输出，所以是「停下」态的闪烁 */}
        {streaming && !turn.response && !commentary.length && !turn.tools.length && !turn.thinking ? (
          <Caret idle className="cursor" />
        ) : null}
        {/* 完成时刻、用时、复制：回复正文之下 */}
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
        ? parts.map((part, index) => <Paragraph key={part.id} text={part.text} sourceCwd={part.sourceCwd} primary live={live && index === parts.length - 1} />)
        : <Paragraph text={response.text} sourceCwd={response.sourceCwd} primary live={live} />}
    </div>
  )
}

function ArtifactCard({ artifact }: { artifact: AssistantTurn['artifacts'][number] }) {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const [text, setText] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [htmlMode, setHtmlMode] = useState<'page' | 'source'>('page')
  /* 网页预览：消息内展开到更高的阅读高度；重新载入会重置页面内操作 */
  const [htmlExpanded, setHtmlExpanded] = useState(false)
  const [htmlReload, setHtmlReload] = useState(0)
  const fileUrl = toFileUrl(artifact.path)
  const isHtml = isHtmlArtifact(artifact)
  const isCode = artifact.kind === 'code' || isHtml
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
      data-artifact-id={artifact.id}
      /* 单击在软件内打开，双击在资源管理器定位；按钮与下载链接自己处理点击 */
      onClick={(e) => { if (!unavailable && !(e.target as HTMLElement).closest('a,button')) void previewFile(artifact.path) }}
      onDoubleClick={(e) => { if (!unavailable && !(e.target as HTMLElement).closest('a,button')) void window.yan.revealPath(artifact.path) }}
      title={unavailable ? undefined : t('artifact.cardHint')}
    >
      <div className="artifact-head">
        <Icon name={artifact.kind === 'image' || artifact.kind === 'svg' ? 'sparkles' : 'file'} size={12} />
        <strong title={artifact.description}>{artifact.filename}</strong>
        <span className="artifact-meta">{fmtArtifactBytes(artifact.bytes)}</span>
        {artifact.provider ? <span className="artifact-provider">{artifact.provider}{artifact.model ? ` · ${artifact.model}` : ''}</span> : null}
        <span className="spacer" />
        {/* 卡片操作收进标题行：HTML 的展示切换在前，文件操作在后 */}
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
          <IconButton size="sm" icon="folder-open" label={t('artifact.revealHint')} onClick={() => void window.yan.revealPath(artifact.path)} />
          <IconButton size="sm" icon="copy" label={t('artifact.copyPathHint')} onClick={() => void navigator.clipboard.writeText(artifact.path)} />
        </span> : null}
      </div>
      {artifact.description ? <div className="artifact-description">{artifact.description}</div> : null}
      {artifact.previewable && (artifact.kind === 'image' || artifact.kind === 'svg') ? (
        <div className={`artifact-image-wrap ${unavailable ? 'failed' : ''}`}>
          {!unavailable ? (
            <img
              src={fileUrl}
              alt={artifact.filename}
              className="artifact-image"
              title={t('artifact.zoomHint')}
              onError={(event) => {
                event.currentTarget.hidden = true
                event.currentTarget.parentElement?.classList.add('failed')
              }}
            />
          ) : null}
          {unavailable ? <span className="artifact-preview-error">{artifact.error || t('artifact.noPreview')}</span> : null}
        </div>
      ) : null}
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

/**
 * 一段文字。
 *
 * `primary`：最终回答（正文字色 + 正常行高）；
 * 否则是中间解说（稍淡一点，视觉上从属于回答）。
 *
 * key 用的是段的 id，所以新的一段出现时 React 会挂新节点 →
 * CSS 的 fade-in 动画就会跑（`animation` 只在节点首次挂载时触发）。
 */
function ParagraphImpl({ text, primary, sourceCwd, live }: { text: string; primary?: boolean; sourceCwd?: string; live?: boolean }) {
  /* 流式正文逐字推进（积压大时自动加速，超长文本与减少动效时直接给全文），避免一块一块地蹦出来 */
  const smooth = !!live && text.length < 6000 && !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const shown = useTypewriter(text, smooth)
  return (
    <div className={`turn-para ${primary ? 'primary' : ''}`}>
      <Markdown text={live ? shown : text} sourceCwd={sourceCwd} live={live} />
    </div>
  )
}

/**
 * ⚠️ 这个 memo 是**性能的关键点**，不是可选项。
 *
 * 背景：`groupIntoTurns` 每帧（流式期间 16ms）重建**全部**回合对象，
 * 所以 `TurnView` 的 memo 一定失效、每个回合都会重新渲染。这时如果
 * Paragraph 跟着重渲染，它下面的 Markdown 就会把历史回答全部重解析一遍
 * （实测一次 535ms，见 MessageParts.tsx 顶部）。
 *
 * 这里有效的原因：文本是**字符串**（值比较），回合对象虽是新引用，
 * 但里面的段落文本内容没变，`===` 就直接命中。
 *
 * 所以改这里的 props 时要小心：任何非原始值（对象/数组/函数）都会让
 * 这个 memo 完全失效，退回成「每帧重解析整段会话」。
 */
const Paragraph = memo(
  ParagraphImpl,
  (a, b) => a.text === b.text && a.primary === b.primary && a.sourceCwd === b.sourceCwd && a.live === b.live
)

/** 连续的短解说只收起已经完成的前几条；最后一条始终留在消息流里。 */
function compactProgressCount(parts: readonly { text: string }[]): number {
  let count = 0
  while (count < parts.length - 1) {
    const text = parts[count].text.trim()
    if (!text || text.length > 100 || /\n|^(?:#|>|[-*+]\s|\d+\.\s|`)/.test(text)) break
    count++
  }
  return count >= 3 ? count : 0
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
              <Paragraph key={p.id} text={p.text} sourceCwd={p.sourceCwd} />
            )) : null}
          </div>
        </>
      ) : null}
      {parts.slice(compactCount).map((p, index, visible) => (
        <Paragraph key={p.id} text={p.text} sourceCwd={p.sourceCwd} live={!!liveSourceId && p.id.startsWith(liveSourceId + '#') && index === visible.length - 1} />
      ))}
    </div>
  )
}
