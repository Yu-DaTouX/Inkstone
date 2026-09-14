import { memo } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { forkFromText } from '../../lib/fork'
import { Markdown } from './MessageParts'
import { ReasoningCapsule } from './Reasoning'
import { ToolGroup, ToolRow } from './ToolRow'
import type { AssistantTurn, BashTurn, Turn, UserTurn } from '../../../../shared/turns'

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
function ParagraphImpl({ text, primary }: { text: string; primary?: boolean }) {
  return (
    <div className={`turn-para ${primary ? 'primary' : ''}`}>
      <Markdown text={text} />
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
const Paragraph = memo(ParagraphImpl, (a, b) => a.text === b.text && a.primary === b.primary)

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
  const hasThinking = !!turn.thinking

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
      {/* 思考（推理胶囊）：没有思考就不渲染，不占位。
          turnLive=整个回合是否还在跑（含工具执行）—— 推理窗口要等回合
          结束才折叠，不能因为「第一段思考结束、开始调工具」就藏起来 */}
      {hasThinking ? (
        <ReasoningCapsule
          text={turn.thinking}
          ms={turn.thinkingMs}
          live={turn.thinkingLive}
          turnLive={streaming}
        />
      ) : null}

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
    </>
  )
}
