import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useState } from 'react'
import type { UIToolCall } from '../../../shared/ipc'

/**
 * 共享的渲染件：Markdown / 工具行 / 工具详情。
 *
 * 为什么从 Message.tsx 里拆出来：回合视图（TurnView.tsx）也要用它们。
 * Message.tsx 现在只剩「单条消息」的渲染，而应用主路径已经改成
 * TurnView —— 两边都需要工具行，放在这里才不会复制一份。
 */

export function Markdown({ text }: { text: string }) {
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

/**
 * 只读工具 —— 终端里它们就是一行 `→ read path`，不该把内容铺出来。
 *
 * 区分「看」与「改」：看的东西随时可重现（再读一次就行），
 * 改的东西过后就看不到了（diff 是历史快照）。所以盒子留给后者。
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'recall',
  'web_search',
  'fetch',
  'task'
])

/** 终端风格的箭头前缀：→ 看，~ 改，$ 执行 */
export function toolArrow(name: string): string {
  if (name === 'bash') return '$'
  if (name === 'edit' || name === 'write') return '~'
  if (name === 'remember' || name === 'forget') return '✎'
  return '→'
}

export function toolIcon(name: string): string {
  return TOOL_ICON[name] ?? 'checklist'
}

/** 给别处备用（工具名 → 图标）；终端风格下摘要行不再画图标 */

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
 * 终端风格：**一行**，不是一张卡。
 *   → read    ~/x.ts                      12 行
 *   $ bash    git status                  1.2k
 *   ~ edit    src/a.ts · 2 处             已完成
 *
 * 展开才把输出/diff 放出来（包含框框住 —— 终端里只有真正「执行出来的东西」才有框）。
 *
 * 展开规则：
 *   · 正在跑 / 用户主动执行的 ! 命令 → 默认展开
 *   · 失败**不**自动展开（用户反馈过：失败输出几十行会把后续对话推走），
 *     但摘要行会标红写「失败」，想看点一下
 *   · 手动点过之后就不再被自动规则推翻
 */
export function ToolCard({ call, defaultOpen }: { call: UIToolCall; defaultOpen?: boolean }) {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)

  const running = call.status === 'running' || call.status === 'pending'
  /** 只用于摘要行标状态，不参与「是否展开」的判断 */
  const failed = call.status === 'error'

  const auto = !!defaultOpen || running
  const open = manual ?? auto

  const summary = summarize(call)
  const outLen = call.output?.length ?? 0
  const readonly = READ_ONLY_TOOLS.has(call.name)

  return (
    <div
      className={`tool ${open ? 'open' : ''} ${readonly ? 'ro' : ''}`}
      data-state={call.status}
      data-tool={call.name}
    >
      <button
        className="tool-head"
        onClick={() => setManual(!open)}
        aria-expanded={open}
      >
        <span className="tool-arrow">{toolArrow(call.name)}</span>
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
            <span>{outLen > 0 ? `${outLen} ${t('tool.chars')}` : t('tool.done')}</span>
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

export function ToolDetail({ call }: { call: UIToolCall }) {
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
