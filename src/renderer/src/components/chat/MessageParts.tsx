import { memo } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'
import type { UIToolCall } from '../../../../shared/ipc'

/**
 * 共享的渲染件：Markdown / 工具行 / 工具详情。
 *
 * 为什么从 Message.tsx 里拆出来：回合视图（TurnView.tsx）也要用它们。
 * Message.tsx 现在只剩「单条消息」的渲染，而应用主路径已经改成
 * TurnView —— 两边都需要工具行，放在这里才不会复制一份。
 */

/* ---------------------------------------------------------------- Markdown */

/*
 * ⚠️ 这里是整个界面**最热**的一段代码：流式期间每 16ms 会重渲染一轮，
 *    而历史上每次重渲染都把**整段会话的所有 Markdown 全部重新解析**。
 *    实测（2026-09 的一份 20MB 真实会话）：全量一次 535ms，60fps 下
 *    根本跑不动 —— 这就是用户报的「卡顿峰值」。所以做了三件事：
 *
 *  ① **插件数组提成常量**。以前是内联数组，每次渲染新建一个引用，
 *     react-markdown 内部按引用做 memo 就全失效了。
 *  ② **关掉 highlightAuto（detect: true）**。开着的时候，每一个**没写语言**
 *     的代码块都会跑一次 hljs.highlightAuto —— 它会拿全文去跟所有语言
 *     逐个试。实测单个未标注代码块 ≈ 30ms，而流式期间代码块还是
 *     未闭合的，每帧都要重试一次。这一项占了那 535ms 里的约 400ms。
 *     代价：没有语言标注的块不再自动上色（宁可不猜，也不卡）。
 *  ③ **结果缓存 + memo**。段落文本不变就直接复用上一次渲染的元素树。
 *
 * 未闭合的围欄（正在流的 ``` 块）**不入缓存**：它是中间态、每帧都变，
 * 进了缓存只会把真正稳定的历史段落挤出去（缓存本身也是 LRU）。
 */
const MD_REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm]
const MD_REHYPE: NonNullable<Options['rehypePlugins']> = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }]
]
const MD_REHYPE_PLAIN: NonNullable<Options['rehypePlugins']> = []

const MD_CACHE_LIMIT = 200
const MD_CACHE_MAX_CHARS = 20_000
const mdCache = new Map<string, React.ReactElement>()

const MD_COMPONENTS = {
  a: LinkAnchor,
  // 表格用等宽栅格，横向可滚
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  )
}

/**
 * 链接 = 统一入口（方案 5.2）。
 *
 * 以前是 `target="_blank"` 交给系统浏览器 —— 结果是：网页跳出应用、
 * 文件路径根本没有反应（Windows 下 `C:\a\b.ts` 也不是合法 URL）。
 *
 * 现在：
 *   · http/https → 右侧内部浏览器打开（菜单里另有外部浏览器入口）
 *   · 文件路径（绝对/相对/`path:42`）→ 右侧只读文件预览
 *   · 危险协议（javascript:/data:/vbs…）→ 不开，样式上也不像可点的链接
 *
 * 识别只作用于**显式链接**（Markdown 语法 / GFM 自动链接）：
 * 代码块、代码示例与流式输出里的半截路径不会被改写。
 */
function LinkAnchor({ href, children }: { href?: string; children?: React.ReactNode }) {
  const t = useT()
  const openBrowser = useStore((s) => s.openBrowser)
  const previewFile = useStore((s) => s.previewFile)

  const target = classifyLink(href)

  const onClick = (e: React.MouseEvent): void => {
    /*
     * 不用 preventDefault 的话，`<a href>` 会让整个渲染进程导航走 ——
     * 而窗口里没有地址栏，导航走了就回不来了。
     */
    e.preventDefault()
    e.stopPropagation()
    if (target.kind === 'url') void openBrowser(target.url)
    else if (target.kind === 'file') void previewFile(target.path, target.line)
    /* invalid：什么也不做（title 已说明原因） */
  }

  const title =
    target.kind === 'file'
      ? t('link.preview', { path: target.path })
      : target.kind === 'invalid'
        ? t('link.blocked')
        : target.url

  return (
    <a
      href={target.kind === 'url' ? target.url : '#'}
      className={`md-link ${target.kind === 'invalid' ? 'blocked' : ''}`}
      data-link-kind={target.kind}
      title={title}
      onClick={onClick}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  )
}

/** 是否停在一个没闭合的代码围欄里（流式中的半截代码块） */
function hasUnclosedFence(text: string): boolean {
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) n++
  }
  return n % 2 === 1
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const cached = mdCache.get(text)
  if (cached) return cached

  const unclosed = hasUnclosedFence(text)
  const el = (
    <div className="prose md">
      <ReactMarkdown
        remarkPlugins={MD_REMARK}
        // 未闭合的代码块**不做高亮**：它每帧都在变，highlightAuto 会
        // 拿半截代码去逐个试所有语言（实测单块 30ms）。
        rehypePlugins={unclosed ? MD_REHYPE_PLAIN : MD_REHYPE}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )

  if (!unclosed && text.length <= MD_CACHE_MAX_CHARS) {
    if (mdCache.size >= MD_CACHE_LIMIT) {
      const oldest = mdCache.keys().next().value
      if (oldest !== undefined) mdCache.delete(oldest)
    }
    mdCache.set(text, el)
  }
  return el
})

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
