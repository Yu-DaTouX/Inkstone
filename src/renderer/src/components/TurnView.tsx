import { useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { forkFromText } from './Rail'
import { Markdown, ToolCard } from './MessageParts'
import type { AssistantTurn, BashTurn, Turn, UserTurn } from '../../../shared/turns'

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

export function TurnView({ turn, streaming }: { turn: Turn; streaming?: boolean }) {
  if (turn.kind === 'user') return <UserTurnView turn={turn} />
  if (turn.kind === 'bash') return <BashTurnView turn={turn} />
  return <AssistantTurnView turn={turn} streaming={streaming} />
}

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
            {msg.images.map((im, i) => (
              <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
            ))}
          </div>
        ) : null}

        {msg.text ? <div className="bubble">{msg.text}</div> : null}
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
        {/* 用户主动跑的命令默认展开 —— 他是为了看结果才跑的 */}
        {(msg.toolCalls ?? []).map((c) => (
          <ToolCard key={c.id} call={c} defaultOpen />
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
  const t = useT()

  const hasBody =
    turn.commentary.length > 0 ||
    !!turn.response ||
    turn.tools.length > 0 ||
    !!turn.thinking ||
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
        <div className="msg-label">
          <span>{t('chat.assistant')}</span>
          {/* 合并的证据：一个回合里有几次工具往返，标出来 */}
          {turn.tools.length > 1 ? (
            <span className="msg-turn-count" title={t('turn.merged', { n: turn.sourceIds.length })}>
              {t('turn.steps', { n: turn.tools.length })}
            </span>
          ) : null}
        </div>

        {/*
         * 渲染顺序：**模型说话 → 工作执行栏 → 回复**（用户指定）。
         *
         * ⚠️ 之前是「执行栏 → 说话 → 回复」，而执行栏说的是
         *   「推理了 1 次，执行了 30 次工具」—— 用户先看到一堆工作量，
         *   却还没看到模型说过一句话，读起来是乱的（用户报的顺序问题）。
         *
         * 现在：先让它出声（中间解说），然后用一条**横条**把
         * 「干了多少活」隔开，最后才是结论。
         */}

        {/* 1. 模型说话：按段落排 */}
        {turn.commentary.length ? (
          <div className="turn-commentary" data-testid="turn-commentary">
            {turn.commentary.map((p) => (
              <Paragraph key={p.id} text={p.text} />
            ))}
          </div>
        ) : null}

        {/* 2. 工作执行栏：思考 + 全部工具（合并后只有一条可展开的条） */}
        <TurnActivity turn={turn} streaming={streaming} />

        {/* 3. 回复 */}
        {turn.response ? (
          <div className="turn-response" data-testid="turn-response">
            <Paragraph text={turn.response.text} primary />
          </div>
        ) : null}

        {turn.error ? (
          <div className="msg-error">
            <Icon name="alert-circle" size={12} />
            <span>{turn.error}</span>
          </div>
        ) : null}

        {/* 刚开始、什么都还没有时给个光标 */}
        {streaming && !turn.response && !turn.commentary.length && !turn.tools.length && !turn.thinking ? (
          <span className="cursor" />
        ) : null}
      </div>
    </article>
  )
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
function Paragraph({ text, primary }: { text: string; primary?: boolean }) {
  return (
    <div className={`turn-para ${primary ? 'primary' : ''}`}>
      <Markdown text={text} />
    </div>
  )
}

/**
 * 整轮活动摘要 —— 「推理了 N 次 · 执行了 M 次工具」。
 *
 * 合并之后这里的 N/M 是**整个回合**的合计（不是一个 API 往返的）。
 * 一个回合十几次工具往返很常见，平铺出来会把回答淹掉，所以收进一行。
 *
 * 自动展开规则（沿用之前定下的，用户反馈过失败输出撑屏）：
 *   · 正在跑 / 正在流式 → 展开（用户在等，要看进度）
 *   · 失败 → 只把摘要行标红，**不自动展开**（失败输出经常几十行）
 *   · 用户手动点过之后不再被自动规则推翻
 */
function TurnActivity({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }) {
  const t = useT()
  const tools = turn.tools
  const hasThinking = !!turn.thinking
  const [manual, setManual] = useState<boolean | null>(null)

  if (!hasThinking && tools.length === 0) return null

  const failed = tools.some((c) => c.status === 'error')
  const running = streaming && tools.some((c) => c.status === 'running' || c.status === 'pending')
  const open = manual ?? running

  // 摘要只报数量，不堆细节
  const parts: string[] = []
  if (hasThinking) parts.push(t('turn.reasoned', { n: 1 }))
  if (tools.length) parts.push(t('turn.tools', { n: tools.length }))
  if (failed) parts.push(t('turn.failed'))

  /**
   * 只有一条工具、没有思考 → 直接平铺那一行。
   * 折叠反而多一次点击（进这个分支的 `!` 命令已经在 BashTurnView 里处理了）。
   */
  if (!hasThinking && tools.length === 1) {
    return <ToolCard call={tools[0]} />
  }

  return (
    <div className={`turn ${open ? 'open' : ''}`} data-testid="turn-activity">
      <button className="turn-head" onClick={() => setManual(!open)} aria-expanded={open}>
        <Icon name="chevron-right" size={12} className="chev" />
        <span className="turn-sum">{parts.join(t('turn.sep'))}</span>
        <span className="turn-gap" />
        {running ? <span className="cursor cursor-inline" /> : null}
      </button>

      {open ? (
        <div className="turn-body">
          {hasThinking ? <Thinking text={turn.thinking} ms={turn.thinkingMs} live={streaming} /> : null}
          {tools.map((c) => (
            <ToolCard key={c.id} call={c} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ 思考 */

export function Thinking({ text, ms, live }: { text: string; ms?: number; live?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : null

  /**
   * 三种标题，别弄混：
   *   live       还在流式思考 →「正在思考…」
   *   有耗时     历史上我们亲眼见过开始/结束 →「已思考 N 秒」
   *   无耗时     从会话历史加载的（没看到事件流）→「思考过程」
   */
  const label = live ? t('chat.thinkingNow') : secs ? t('chat.thinking', { n: secs }) : t('chat.thought')

  return (
    <details className="think" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="chevron-right" size={12} className="chev" />
        <span>{label}</span>
        {live ? <span className="cursor cursor-inline" /> : null}
      </summary>
      <div className="think-body">{text}</div>
    </details>
  )
}
