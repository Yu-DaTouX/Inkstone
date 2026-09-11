import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { forkFromText } from './Rail'
import type { UIMessage, UIToolCall } from '../../../shared/ipc'

/**
 * 一条消息。
 *
 * 刻意的**不对称**：用户有气泡容器，助手直接排在背景上（DESIGN §8）。
 * 角色靠左侧符号槽区分：你 = ›，砚 = ✦。
 */
export function Message({ msg, streaming }: { msg: UIMessage; streaming?: boolean }) {
  const t = useT()
  const isUser = msg.role === 'user'

  const hasBody =
    !!msg.text.trim() || (msg.toolCalls?.length ?? 0) > 0 || !!msg.thinking || !!msg.images?.length
  if (!hasBody && !streaming) return null

  return (
    <article
      className={`msg ${isUser ? 'user' : msg.role === 'bash' ? 'bash' : 'assistant'} ${streaming ? 'streaming' : ''}`}
      data-msg-id={msg.id}
    >
      <div className="gutter">
        {isUser ? '›' : msg.role === 'bash' ? '$' : <Icon name="sparkle" size={12} />}
      </div>
      <div className="msg-body">
        <div className="msg-label">
          <span>{isUser ? t('chat.you') : msg.role === 'bash' ? t('chat.bash') : t('chat.assistant')}</span>
          {isUser ? (
            <button className="msg-act" title={t('chat.forkHere')} onClick={() => void forkFromText(msg.text)}>
              <Icon name="layers" size={12} />
              {t('chat.fork')}
            </button>
          ) : null}
        </div>

        {msg.images?.length ? (
          <div className="msg-images">
            {msg.images.map((im, i) => (
              <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
            ))}
          </div>
        ) : null}

        {isUser && msg.text ? <div className="bubble">{msg.text}</div> : null}

        {/* 整轮摘要：把「推理」与「工具调用」收在一行里。
            对齐 Agents-Anywhere 的做法 —— 一个回合里可能有十几次工具往返，
            每张卡都平铺出来会把回答本身淹掉。
            默认收起；但失败 / 含 diff / 进行中的回合自动展开（参见 ToolCard 的规则）。 */}
        <TurnActivity msg={msg} streaming={streaming} />

        {!isUser && msg.text.trim() ? <Markdown text={msg.text} /> : null}

        {msg.error ? (
          <div className="msg-error">
            <Icon name="alert-circle" size={12} />
            <span>{msg.error}</span>
          </div>
        ) : null}

        {streaming && !msg.text && !msg.thinking && !msg.toolCalls?.length ? <span className="cursor" /> : null}
      </div>
    </article>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`
  return `${n} tok`
}

/* ------------------------------------------------------------------ 思考 */
/**
 * 整轮活动摘要 —— 「推理了 N 次，执行了 M 次工具」。
 *
 * 为什么要把思考和工具收进一行（对齐 Agents-Anywhere）：
 *   一个回合可能有十几次工具往返，平铺出来会把回答本身淹掉。
 *
 * 自动展开的条件（与 ToolCard 的智能展开一致）：
 *   · 正在流式（用户在等，需要看到进度）
 *   · 有失败的工具（要让人立刻看到出错了）
 *   · 有 edit / write（改动了文件，属于需要过目的内容）
 * 用户手动点过之后就不再被自动规则推翻。
 */
function TurnActivity({ msg, streaming }: { msg: UIMessage; streaming?: boolean }) {
  const t = useT()
  const tools = msg.toolCalls ?? []
  const hasThinking = !!msg.thinking
  const [manual, setManual] = useState<boolean | null>(null)

  if (!hasThinking && tools.length === 0) return null

  const failed = tools.some((c) => c.status === 'error')
  const changed = tools.some((c) => c.name === 'edit' || c.name === 'write')
  const running = streaming && tools.some((c) => c.status === 'running' || c.status === 'pending')

  /**
   * 自动展开规则：
   *   · 正在流式 / 有工具在跑 → 展开（用户在等，要看进度）
   *   · 有失败的 → 展开（要立刻看到出错了）
   *   · 改动了文件 **且正在流式** → 展开（正在发生的改动要过目）
   *   历史回合的改动**不自动展开** —— 否则翻回一个长会话，
   *   满屏都是 diff 卡，正文完全被淹没。摘要行上写着「执行了 N 次工具」，
   *   想看细节点一下就行。
   */
  /**
   * 自动展开规则（用户反馈"失败的工具卡撑满屏"后调整）：
   *   · 正在跑 / 正在流式 → 展开（用户在等）
   *   · 改动了文件 **且正在流式** → 展开（正在发生的改动要过目）
   *   · **失败** → 只把摘要行标红，**不自动展开** ——
   *     失败的命令输出经常几十行，全展开会把后续对话推出视野。
   *     摘要行上写着「有失败」，想看细节点一下。
   * 历史回合一概不自动展开。
   */
  const auto = running && !!streaming
  const open = manual ?? auto

  // 摘要只报数量，不堆细节
  const parts: string[] = []
  if (hasThinking) parts.push(t('turn.reasoned', { n: 1 }))
  if (tools.length) parts.push(t('turn.tools', { n: tools.length }))
  if (failed) parts.push(t('turn.failed'))

  /**
   * 平铺 vs 折叠的判据：
   *   · 单条工具 + 没思考 → 平铺（折叠反而多一次点击）
   *   · **用户主动执行的 ! 命令** → 平铺且展开（msg.role === 'bash'）——
   *     他就是为了看结果/看错误才跑的，包进折叠里等于白跑
   *   · 其余（多工具、有思考）→ 收进一行摘要
   */
  const isUserBash = msg.role === 'bash'
  if (!hasThinking && tools.length === 1 && (!failed || isUserBash) && !changed) {
    return (
      <>
        {tools.map((c) => (
          <ToolCard key={c.id} call={c} defaultOpen={msg.role === 'bash'} />
        ))}
      </>
    )
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
          {hasThinking ? <Thinking text={msg.thinking!} ms={msg.thinkingMs} live={streaming} /> : null}
          {tools.map((c) => (
            <ToolCard key={c.id} call={c} defaultOpen={msg.role === 'bash'} />
          ))}
        </div>
      ) : null}
    </div>
  )
}


function Thinking({ text, ms, live }: { text: string; ms?: number; live?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : null

  /**
   * 三种标题，别弄混：
   *   live       还在流式思考 →「正在思考…」
   *   有耗时     历史上我们亲眼见过开始/结束 →「已思考 N 秒」
   *   无耗时     从会话历史加载的（没看到事件流）→「思考过程」
   *
   * 最后那种以前会错误地显示「正在思考…」——一条早就完结的历史消息
   * 永远在「正在思考」，看着像卡住了。
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

/* --------------------------------------------------------------- Markdown */
function Markdown({ text }: { text: string }) {
  return (
    <div className="prose md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // 链接一律交给系统浏览器（setWindowOpenHandler 已限流）
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          // 表格用等宽栅格，横向可滚
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/* ---------------------------------------------------------------- 工具卡 */

const TOOL_ICON: Record<string, string> = {
  bash: 'activity',
  read: 'message-dots',
  write: 'plus',
  edit: 'checklist',
  grep: 'search',
  glob: 'folder',
  list: 'folder',
  remember: 'sparkles',
  recall: 'search',
  forget: 'alert-circle',
  task: 'layers',
  web_search: 'search',
  fetch: 'history'
}

function toolIcon(name: string): string {
  return TOOL_ICON[name] ?? 'checklist'
}

/** 从参数里抠出一行摘要 —— 折叠时也要能看懂它干了什么 */
function summarize(call: UIToolCall): string {
  const a = call.args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return ''

  // pi 的 edit：path + edits[]，摘要显示路径和改动块数
  if (Array.isArray(a.edits)) {
    const p = typeof a.path === 'string' ? a.path : ''
    return `${shortPath(p)} · ${a.edits.length} 处`
  }

  if (typeof a.command === 'string') return a.command
  if (typeof a.file_path === 'string') return shortPath(a.file_path)
  if (typeof a.path === 'string') return shortPath(a.path)
  if (typeof a.pattern === 'string') return a.pattern
  if (typeof a.query === 'string') return a.query
  if (typeof a.text === 'string') return a.text
  if (typeof a.url === 'string') return a.url

  const keys = Object.keys(a)
  return keys.length ? keys.slice(0, 3).join(', ') : ''
}

/** 路径把家目录缩成 ~，否则一行摘要全被路径吃掉了 */
function shortPath(p: string): string {
  return p.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~')
}

/** 提取 edit 的改动块，兼容当前 schema（edits[]）与旧 schema（顶层 oldText/newText） */
function extractEdits(args: unknown): { oldText: string; newText: string }[] {
  const a = args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return []

  const out: { oldText: string; newText: string }[] = []

  if (Array.isArray(a.edits)) {
    for (const e of a.edits) {
      const o = e as { oldText?: unknown; newText?: unknown }
      out.push({ oldText: String(o.oldText ?? ''), newText: String(o.newText ?? '') })
    }
  }

  // 旧版 pi / 其它客户端可能把 old/new 放在顶层
  if (out.length === 0 && (typeof a.oldText === 'string' || typeof a.newText === 'string')) {
    out.push({ oldText: String(a.oldText ?? ''), newText: String(a.newText ?? '') })
  }
  if (out.length === 0 && (typeof a.old_string === 'string' || typeof a.new_string === 'string')) {
    out.push({ oldText: String(a.old_string ?? ''), newText: String(a.new_string ?? '') })
  }

  return out
}

/**
 * 工具卡。
 *
 * 展开规则（DESIGN §3.1 的智能展开）：
 *   · 正在跑 / 用户主动执行的 ! 命令 → 默认展开
 *   · 其余（含失败、含 diff）→ 折叠，但留一行摘要并在摘要上标状态
 *   · 用户手动点过之后就转手动（state 存在组件里），不再被自动规则推翻
 *   · 失败**不自动展开**是刻意的：失败输出经常几十行，全展开会把
 *     后续对话推出视野；摘要行会显示「失败」，要点开很容易
 */
function ToolCard({ call, defaultOpen }: { call: UIToolCall; defaultOpen?: boolean }) {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)

  const running = call.status === 'running' || call.status === 'pending'
  /** 只用于摘要行标状态，不参与「是否展开」的判断 */
  const failed = call.status === 'error'

  /**
   * 卡片何时自动展开。
   *
   * 曾经是「进行中 / 失败 / 含 diff 都展开」—— 用户反馈：
   * 失败的命令输出几十行，全展开把后续对话直接推出视野。
   * 现在只保留：
   *   · 正在跑 → 展开（用户在等，要看到进度）
   *   · defaultOpen（用户主动执行的 `!` 命令）→ 展开（他是为了看结果才跑的）
   * 失败与改动**只标色不展开** —— 摘要行会说明状态，想看细节点一下。
   */
  const auto = !!defaultOpen || running
  const open = manual ?? auto

  const summary = summarize(call)
  const outLen = call.output?.length ?? 0

  return (
    <div className={`tool ${open ? 'open' : ''}`} data-state={call.status} data-tool={call.name}>
      <button
        className="tool-head"
        onClick={() => setManual(!open)}
        aria-expanded={open}
      >
        <Icon name="chevron-right" size={12} className="chev" />
        <Icon name={toolIcon(call.name) as never} size={12} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-sum">{summary}</span>
        <span className="tool-gap" />
        <span className={`tool-status ${call.status}`}>
          {running ? (
            <>
              <Icon name="refresh" size={12} className="spin" />
              <span>{t('tool.running')}</span>
            </>
          ) : failed ? (
            <>
              <Icon name="alert-circle" size={12} />
              <span>{t('tool.failed')}</span>
            </>
          ) : (
            <>
              <Icon name="check" size={12} />
              <span>{outLen > 0 ? `${outLen} ${t('tool.chars')}` : t('tool.done')}</span>
            </>
          )}
        </span>
      </button>

      {open ? (
        <div className="tool-body">
          <ToolDetail call={call} />
        </div>
      ) : null}
    </div>
  )
}

function ToolDetail({ call }: { call: UIToolCall }) {
  const t = useT()
  const a = (call.args ?? {}) as Record<string, unknown>

  /* ---- edit：渲染成真正的 diff ---- */
  if (call.name === 'edit') {
    const edits = extractEdits(call.args)
    if (edits.length > 0) {
      return (
        <>
          {typeof a.path === 'string' ? (
            <div className="tool-path" title={a.path}>
              {a.path}
            </div>
          ) : null}
          {edits.map((e, i) => (
            <div className="diff" key={i}>
              {e.oldText ? (
                <div className="diff-side">
                  <div className="diff-label err">{t('tool.before')}</div>
                  <pre className="diff-pre del">{e.oldText}</pre>
                </div>
              ) : null}
              {e.newText ? (
                <div className="diff-side">
                  <div className="diff-label ok">{t('tool.after')}</div>
                  <pre className="diff-pre add">{e.newText}</pre>
                </div>
              ) : null}
            </div>
          ))}
          {call.output ? <div className="tool-result">{call.output}</div> : null}
        </>
      )
    }
  }

  /* ---- write：显示完整内容（写入是整文件，就是新增） ---- */
  if (call.name === 'write' && typeof a.content === 'string') {
    return (
      <>
        {typeof a.path === 'string' ? (
          <div className="tool-path" title={a.path}>
            {a.path}
          </div>
        ) : null}
        <pre className="diff-pre add write-body">{a.content}</pre>
        {call.output ? <div className="tool-result">{call.output}</div> : null}
      </>
    )
  }

  /* ---- 通用：命令/参数 + 输出 ---- */
  const argsText = call.args && Object.keys(a).length ? JSON.stringify(call.args, null, 2) : call.argsRaw

  return (
    <>
      {argsText ? <pre className="tool-pre args">{argsText}</pre> : null}
      {call.output ? <pre className="tool-pre out">{call.output}</pre> : null}
      {!call.output && call.status === 'ok' ? <div className="tool-empty">{t('tool.noOutput')}</div> : null}
    </>
  )
}
