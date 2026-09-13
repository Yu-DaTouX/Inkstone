import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useT } from '../../i18n'
import type { UIToolCall } from '../../../../shared/ipc'

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

/* ---------------------------------------------------------------- 工具详情 */

/*
 * 这里曾经还有：`TOOL_ICON`、`READ_ONLY_TOOLS`、`summarize`、`shortPath`。
 * 它们都是给 `ToolCard` 服务的 —— 用户要求「工具调用模拟 codex」之后，
 * 一行式工具行（chat/ToolRow.tsx）自带自己的摘要与图标逻辑，
 * 这四个就没使用者了，一起删掉（避免出现两条并行的工具渲染路径）。
 */

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

/*
 * ⚠️ 这里曾经有一个 `ToolCard`（一张可展开的工具卡）。
 *    用户要求「工具调用模拟 codex」后，它被 `chat/ToolRow.tsx` 的一行式
 *    工具行取代（Codex 是一行一条命令，不是一张卡）。
 *    它连同 `toolArrow` / `toolIcon` / `summarize` / `shortPath`
 *    一起删掉了 —— 留在文件里会让人以为还有两条工具渲染路径。
 *    保留下来的只有 ToolDetail：它是**展开后的内容**，与怎么折叠无关。
 */
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
