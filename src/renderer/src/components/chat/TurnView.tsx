import { memo, useEffect, useId, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { forkFromText } from '../../lib/fork'
import { Markdown } from './MessageParts'
import { ReasoningCapsule } from './Reasoning'
import { ToolGroup, ToolRow } from './ToolRow'
import type { AssistantTurn, BashTurn, Turn, UserTurn } from '../../../../shared/turns'
import { formatDuration } from '../../../../shared/duration'
import { fileUrl as toFileUrl } from '../../../../shared/file-url'

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
 * （见 redesign.css 的 `.turn-para`）。
 */

export const TurnView = memo(function TurnView({ turn, streaming }: { turn: Turn; streaming?: boolean }) {
  if (turn.kind === 'user') return <UserTurnView turn={turn} />
  if (turn.kind === 'bash') return <BashTurnView turn={turn} />
  return <AssistantTurnView turn={turn} streaming={streaming} />
})

/* ------------------------------------------------------------------ 用户 */

function UserTurnView({ turn }: { turn: UserTurn }) {
  const t = useT()
  const msg = turn.msg

  return (
    <article className="msg user" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="gutter">
        <span className="gutter-prompt">❯</span>
      </div>
      <div className="msg-body">
        <div className="msg-label">
          <span>{t('chat.you')}</span>
          <button
            className="msg-act"
            title={t('chat.forkHere')}
            onClick={() => void forkFromText(msg.text)}
          >
            <Icon name="layers" size={12} />
            {t('chat.fork')}
          </button>
        </div>

        {msg.images?.length ? (
          <div className="msg-images">
            {msg.images.map((im, i) =>
              im.data ? (
                <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
              ) : im.url ? (
                /* 历史里的图：已落盘，直接读文件（重启后也看得到） */
                <img key={i} src={im.url} alt="" />
              ) : (
                /*
                 * 历史回放时图片数据被体积保护丢掉了（见 state/keep-images.ts）。
                 * 摆一个「图片未载入」而不是整个不渲染 —— 后者看起来就像这条
                 * 消息压根没贴过图。
                 */
                <div key={i} className="msg-image-missing" title={t('chat.imageMissing')}>
                  <Icon name="tag" size={12} />
                  <span>{t('chat.imageMissing')}</span>
                </div>
              )
            )}
          </div>
        ) : null}

        {msg.text ? <div className="bubble">{msg.text}</div> : null}
        {msg.timestamp ? (
          <div className="turn-footer">
            <TurnTime timestamp={msg.timestamp} />
          </div>
        ) : null}
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
        {(msg.toolCalls ?? []).map((c) => (
          <ToolRow key={c.id} call={c} />
        ))}
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

function AssistantTurnView({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }) {
  /*
   * 成功进度只是过程状态：artifact 已经落盘后，用户需要看到的是最终文件，
   * 不是一张永远停在「已完成」的进度卡。失败则保留，方便解释原因并重试。
   * 进度数据仍留在回合模型里，历史 / 调试不会丢失，只是不再占用消息流。
   */
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
        <Icon name="sparkle" size={12} />
      </div>
      <div className="msg-body">
        {visibleImageProgress.length ? <ImageProgressList items={visibleImageProgress} /> : null}
        {/* 同一回合的非正式输出连续阅读；短进展折叠也只出现一次。 */}
        {commentary.length ? <CommentaryList parts={commentary} /> : null}

        {/* 正式回复仍逐段保留，避免自主续跑时把不同来源的正文拼成一段。 */}
        {segmented
          ? turn.segments.map((segment) => (
              segment.response ? <TurnResponse key={segment.id} response={segment.response} parts={segment.responseParts} /> : null
            ))
          : turn.response && !turn.response.hasTools
            ? <TurnResponse response={turn.response} parts={turn.responseParts} />
            : null}

        {/* 工具与推理属于可回看的过程记录，集中排在正文下方。 */}
        <TurnActivity turn={turn} streaming={streaming} />

        {turn.artifacts.length ? (
          <div className="turn-artifacts" data-testid="turn-artifacts">
            {turn.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
          </div>
        ) : null}

        {turn.error ? (
          <div className="msg-error">
            <Icon name="alert-circle" size={12} />
            <span>{turn.error}</span>
          </div>
        ) : null}

        {/* 刚开始、什么都还没有时给个光标 */}
        {streaming && !turn.response && !commentary.length && !turn.tools.length && !turn.thinking ? (
          <span className="cursor" />
        ) : null}
        <TurnFooter turn={turn} />
      </div>
    </article>
  )
}

function TurnResponse({
  response,
  parts
}: {
  response: NonNullable<AssistantTurn['response']>
  parts?: AssistantTurn['responseParts']
}) {
  return (
    <div className="turn-response" data-testid="turn-response">
      {parts?.length
        ? parts.map((part) => <Paragraph key={part.id} text={part.text} sourceCwd={part.sourceCwd} primary />)
        : <Paragraph text={response.text} sourceCwd={response.sourceCwd} primary />}
    </div>
  )
}

/** 回合底部只保留可验证的统计；模型名、回复档位与工具步数不再占据正文顶部。 */
function TurnFooter({ turn }: { turn: AssistantTurn }) {
  const t = useT()
  const elapsed = turn.elapsedMs && turn.elapsedMs > 0 ? formatDuration(turn.elapsedMs) : null
  const stopped = turn.terminalReason === 'stopped'
  const failed = turn.terminalReason === 'failed'
  const interrupted = turn.terminalReason === 'interrupted'
  /*
   * 旧历史没有宿主计时记录时不补一个“用时未记录”字段：
   * 这会把完成时刻误读成计时信息。保留真实 timestamp 即可，
   * 有宿主记录的回合才显示整轮用时。
   */
  const hasMeta =
    !!elapsed || !!turn.timestamp || turn.tools.length > 1 || stopped || failed || interrupted
  if (!hasMeta) return null

  return (
    <div className="turn-footer" data-testid="turn-footer">
      {turn.tools.length > 1 ? (
        <span className="turn-footer-item" title={t('turn.merged', { n: turn.sourceIds.length })}>
          {t('turn.steps', { n: turn.tools.length })}
        </span>
      ) : null}
      {elapsed ? (
        /* 悬停要能解释口径：这里是**整轮**墙钟时间（含工具往返与重试）。
           有工具等待分段时补一句「其中等待工具 X」——那是 H-6b 的 waitSpans。
           用量条只展示 token / 速度，不再重复占用时长。 */
        <span
          className="turn-footer-item"
          title={
            turn.waitMs
              ? t('tok.elapsedWaitTip', { n: formatDuration(turn.waitMs) })
              : t('tok.elapsedTip')
          }
        >
          {t('tok.elapsed')} {elapsed}
        </span>
      ) : null}
      {stopped ? <span className="turn-footer-item turn-footer-tag">{t('turn.stopped')}</span> : null}
      {failed ? (
        <span className="turn-footer-item turn-footer-tag err">{t('turn.failed')}</span>
      ) : null}
      {interrupted ? (
        <span className="turn-footer-item turn-footer-tag">{t('turn.interrupted')}</span>
      ) : null}
      {turn.timestamp ? <TurnTime timestamp={turn.timestamp} /> : null}
    </div>
  )
}

function TurnTime({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return null
  const iso = date.toISOString()
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  const full = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  }).format(date)
  /*
   * 完整时间不能只有鼠标悬停才能读到：
   *   · `aria-label` 给屏幕阅读器；
   *   · `tabIndex=0` + `data-full` 让键盘 / 触摸聚焦时由 CSS 弹出浮层
   *     （见 motion.css 的 `.turn-time:focus-visible::after`）；
   *   · `dateTime` 仍是机器可读的 ISO，复制 / 分叉沿用原消息时间。
   */
  return (
    <time
      className="turn-footer-item turn-time"
      dateTime={iso}
      title={full}
      aria-label={full}
      data-full={full}
      tabIndex={0}
    >
      {clock}
    </time>
  )
}

function ArtifactCard({ artifact }: { artifact: AssistantTurn['artifacts'][number] }) {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const [text, setText] = useState<string | null>(null)
  const fileUrl = toFileUrl(artifact.path)
  const isCode = artifact.kind === 'code'
  const unavailable = artifact.unavailable === true || artifact.bytes <= 0

  useEffect(() => {
    let alive = true
    if (!isCode || unavailable) return () => { alive = false }
    void window.yan.readPreview(artifact.path).then((result) => {
      if (alive && result.ok) setText(result.text ?? '')
    }).catch(() => undefined)
    return () => { alive = false }
  }, [artifact.path, isCode, unavailable])

  return (
    <section className="artifact-card" data-artifact-id={artifact.id}>
      <div className="artifact-head">
        <Icon name={artifact.kind === 'image' || artifact.kind === 'svg' ? 'sparkles' : 'tag'} size={12} />
        <strong title={artifact.description}>{artifact.filename}</strong>
        <span className="artifact-meta">{fmtArtifactBytes(artifact.bytes)}</span>
        <span className="spacer" />
        {artifact.provider ? <span className="artifact-provider">{artifact.provider}{artifact.model ? ` · ${artifact.model}` : ''}</span> : null}
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
              onClick={() => void previewFile(artifact.path)}
              onError={(event) => {
                event.currentTarget.hidden = true
                event.currentTarget.parentElement?.classList.add('failed')
              }}
            />
          ) : null}
          {unavailable ? <span className="artifact-preview-error">{artifact.error || '原始文件不可用，无法预览。'}</span> : null}
        </div>
      ) : null}
      {isCode ? (
        <pre className="artifact-code"><code>{unavailable ? (artifact.error || '原始文件不可用，无法预览。') : text ?? '正在读取文件…'}</code></pre>
      ) : null}
      {!artifact.previewable ? <div className="artifact-binary">{unavailable ? (artifact.error || '原始文件不可用。') : '文件已生成，可下载或在资源管理器中查看。'}</div> : null}
      {!unavailable ? (
        <div className="artifact-actions">
          <a className="artifact-download" href={fileUrl} download={artifact.filename}>下载文件</a>
          <button type="button" onClick={() => void previewFile(artifact.path)} title="在右侧预览">右侧预览</button>
          <button type="button" onClick={() => void window.yan.revealPath(artifact.path)} title="在资源管理器中显示">打开位置</button>
          <button type="button" onClick={() => void navigator.clipboard.writeText(artifact.path)} title="复制受控文件路径">复制路径</button>
        </div>
      ) : null}
    </section>
  )
}

function ImageProgressList({ items }: { items: AssistantTurn['imageProgress'] }) {
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
              <strong>生成图片</strong>
              <span className="image-progress-stage">{imageStageLabel(item.stage)}</span>
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

function imageStageLabel(stage: AssistantTurn['imageProgress'][number]['stage']): string {
  switch (stage) {
    case 'queued': return '已排队'
    case 'preparing': return '准备请求'
    case 'confirming': return '等待确认'
    case 'requesting': return '请求模型'
    case 'generating': return '生成中'
    case 'saving': return '保存文件'
    case 'done': return '已完成'
    case 'error': return '失败'
  }
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
function ParagraphImpl({ text, primary, sourceCwd }: { text: string; primary?: boolean; sourceCwd?: string }) {
  return (
    <div className={`turn-para ${primary ? 'primary' : ''}`}>
      <Markdown text={text} sourceCwd={sourceCwd} />
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
  (a, b) => a.text === b.text && a.primary === b.primary && a.sourceCwd === b.sourceCwd
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

function CommentaryList({ parts }: { parts: readonly AssistantTurn['commentary'][number][] }) {
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
      {parts.slice(compactCount).map((p) => (
        <Paragraph key={p.id} text={p.text} sourceCwd={p.sourceCwd} />
      ))}
    </div>
  )
}

/**
 * 整轮活动摘要 —— 「推理了 N 次 · 执行了 M 次工具」。
 *
 * 合并之后这里的 N/M 是**整个回合**的合计（不是一个 API 往返的）。
 * 一个回合十几次工具往返很常见，平铺出来会把回答淹掉，所以收进一行。
 *
 * 展开规则（用户要求：「只展开正在运行的那条」）：
 *   · 正在跑 / 排队中的工具 → 单独一行，自动展开详情（用户在等，要看进度）
 *   · 已结束的工具 → 收进折叠组，默认收起，用户点了才展开
 *   · 失败 → 只把摘要行标红，**不自动展开**（失败输出经常几十行）
 *   · 用户手动点过之后不再被自动规则推翻
 */
function TurnActivity({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }) {
  const tools = turn.tools
  const thinking = turn.thinking
  const thinkingMs = turn.thinkingMs
  const thinkingLive = turn.thinkingLive
  const hasThinking = !!thinking

  /*
   * ⚠️ 这里曾经是个 bug（用户报「为什么我看不到推理」）：
   *   ReasoningCapsule 被 import 了，但**没有任何地方渲染它**，
   *   而函数又在 tools 为空时直接 return null —— 于是「纯推理、还没调工具」
   *   的那一段什么都看不到（推理胶囊整块丢失）。
   *   教训：import 了不等于渲染了；tsconfig 没开 noUnusedLocals 抓不到。
   */
  if (!hasThinking && tools.length === 0) return null

  /*
   * 工具行的展开规则（用户要求：「只展开正在运行的那条」）。
   *
   * 拆成两组，而不是把所有工具塞进同一个组里：
   *   · 正在跑 / 排队中的 → 单独一行渲染，ToolRow 会自动展开它的详情
   *   · 已结束的 → 收进 ToolGroup，默认收起（用户点了才展开）
   * 之前是放同一个组、组在运行中自动展开 —— 于是模型一调工具，
   * 整组（连同所有已结束的行）一起弹开，就是用户报的「整个工具调用栏会展开」。
   */
  const runningTools = tools.filter((c) => c.status === 'running' || c.status === 'pending')
  const doneTools = tools.filter((c) => c.status !== 'running' && c.status !== 'pending')
  /*
   * 并行时只有**最新开始的那条**自动展开（方案 4.2）：
   * 三条命令同时跑，三个终端窗口会把回答顶出屏幕。
   * 其余保持一行，用户点哪条看哪条。
   */
  const activeToolId = runningTools.length ? runningTools[runningTools.length - 1].id : null

  return (
    <>
      {/*
       * 工具调用用 **Codex 风格**（用户要求）：一行一条，已结束的折叠在
       * 「运行了命令 N」下面（见 ToolRow.tsx）。
       *
       * 与上一版的区别：不再把「正在跑」也塞进那个折叠组里 ——
       * 运行中的单独一行、自动展开详情；只有已结束的才进组且默认收起。
       */}
      {runningTools.map((c) => (
        <ToolRow key={c.id} call={c} autoOpen={c.id === activeToolId} />
      ))}
      {doneTools.length === 1 ? (
        <ToolRow call={doneTools[0]} />
      ) : doneTools.length > 1 ? (
        <ToolGroup tools={doneTools} />
      ) : null}
      {/* 思考放在过程记录末尾；仍使用原文，展开状态只由用户操作控制。 */}
      {hasThinking ? (
        <ReasoningCapsule
          text={thinking}
          ms={thinkingMs}
          live={thinkingLive}
          turnLive={streaming}
        />
      ) : null}
    </>
  )
}
