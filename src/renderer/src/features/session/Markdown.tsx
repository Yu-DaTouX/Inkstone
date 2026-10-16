/**
 * v3 对话正文的 Markdown 渲染。
 *
 * 复用 v2 `components/chat/MessageParts.tsx` 的**纯渲染逻辑**（插件数组提常量、
 * 关闭 highlightAuto、按文本缓存已解析元素树、未闭合围栏不高亮），但不引入那
 * 文件里的 v2 控件与 v2 CSS 类：这里只输出 `v3-*` 类名，外观由会话模块自己的
 * `session.css` 负责。
 *
 * 安全边界：
 *   · 不启用 rehype-raw，模型输出的 HTML 不会被当标签执行；
 *   · 链接经 `classifyLink` 分类，`javascript:` / `data:` 等危险协议不渲染成可点；
 *   · 代码块提供复制（读的是已渲染文本，不重跑任何工具）。
 */
import { createContext, useContext, memo, useDeferredValue, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'
import { fileUrl as toFileUrl } from '../../../../shared/file-url'
import { isVisualBlockLang } from '../../../../shared/visual-blocks'
import { MessageImage } from './Image'
import { Icon } from './Icon'
import { VisualFence } from '../artifacts/VisualFence'
import { MermaidBlock } from '../artifacts/MermaidBlock'
import { WidgetIdentityContext, useMarkdownIdentity } from '../artifacts/widget-lifecycle'

/*
 * ① 插件数组提成常量（内联数组每次新建引用会让 react-markdown 的 memo 全失效）；
 * ② 关掉 highlightAuto（未标注语言的块不再自动试所有语言 —— 流式期间那是主要卡顿来源）。
 */
const MD_REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm]
const MD_REHYPE: NonNullable<Options['rehypePlugins']> = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]
const MD_REHYPE_PLAIN: NonNullable<Options['rehypePlugins']> = []

/* 已解析元素树的小缓存：历史段落文本不变就直接复用上一次的树 */
const MD_CACHE_LIMIT = 60
const MD_CACHE_TOTAL_CHARS = 100_000
const mdCache = new Map<string, React.ReactElement>()
let mdCacheChars = 0
function mdCacheSet(text: string, element: React.ReactElement): void {
  const previous = mdCache.get(text)
  if (previous !== undefined) {
    mdCache.delete(text)
    mdCacheChars -= text.length
  }
  mdCache.set(text, element)
  mdCacheChars += text.length
  for (const key of mdCache.keys()) {
    if (mdCache.size <= MD_CACHE_LIMIT && mdCacheChars <= MD_CACHE_TOTAL_CHARS) break
    if (key === text) continue
    mdCache.delete(key)
    mdCacheChars -= key.length
  }
}

const MessageSourceCwd = createContext<string | undefined>(undefined)
/** 正在流式输出的消息：结构化块写完前只占位，不报格式错误。 */
const MarkdownLive = createContext(false)

type HastNode = { position?: { start?: { offset?: number } }; type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** 相对路径按消息的工作目录补全（revealPath 只认绝对路径） */
function resolveAgainstCwd(path: string, cwd?: string): string {
  if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(path) || !cwd) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`
}

/**
 * 链接 = 统一入口：http(s) 进内部浏览器，文件路径进只读预览，
 * 危险协议不开且在样式上也不像链接。
 */
function LinkAnchor({ href, children }: { href?: string; children?: ReactNode }): JSX.Element {
  const t = useT()
  const openBrowser = useStore((s) => s.openBrowser)
  const previewFile = useStore((s) => s.previewFile)
  const sourceCwd = useContext(MessageSourceCwd)
  const target = classifyLink(href)

  const onClick = (e: React.MouseEvent): void => {
    /* 不 preventDefault 会让渲染进程导航走，窗口里没有地址栏就回不来了 */
    e.preventDefault()
    e.stopPropagation()
    if (target.kind === 'url') void openBrowser(target.url)
    else if (target.kind === 'file') void previewFile(target.path, target.line, sourceCwd, target.lineEnd)
  }
  const onDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (target.kind === 'url') void window.yan.browser.openExternal(target.url)
    else if (target.kind === 'file') void window.yan.revealPath(resolveAgainstCwd(target.path, sourceCwd))
  }

  const title =
    target.kind === 'file'
      ? t('link.preview', { path: target.line ? `${target.path}:${target.line}${target.lineEnd ? `-${target.lineEnd}` : ''}` : target.path })
      : target.kind === 'invalid'
        ? t('link.blocked')
        : target.url

  return (
    <a
      href={target.kind === 'url' ? target.url : '#'}
      className={`v3-md-link ${target.kind === 'invalid' ? 'blocked' : ''}`}
      data-link-kind={target.kind}
      data-line={target.kind === 'file' && target.line ? String(target.line) : undefined}
      data-line-end={target.kind === 'file' && target.lineEnd ? String(target.lineEnd) : undefined}
      title={target.kind === 'invalid' ? title : `${title}\n${t('link.dblclickHint')}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  )
}

/** 回复里的 Markdown 图片：本地路径按消息的工作目录解析；危险协议不渲染 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }): JSX.Element | null {
  const sourceCwd = useContext(MessageSourceCwd)
  const target = classifyLink(src)
  if (target.kind === 'invalid') return alt ? <span className="v3-md-image-alt">{alt}</span> : null
  if (target.kind === 'url') {
    if (!/^https?:/i.test(target.url)) return null
    return <MessageImage src={target.url} alt={alt} className="v3-md-image" />
  }
  const abs = /^[a-zA-Z]:[\\/]|^\//.test(target.path) || !sourceCwd
    ? target.path
    : `${sourceCwd.replace(/[\\/]+$/, '')}/${target.path.replace(/^\.[\\/]/, '')}`
  return <MessageImage src={toFileUrl(abs)} alt={alt} sourceCwd={sourceCwd} className="v3-md-image" />
}

/** 行内代码整段就是一个路径 / 网址时双击打开，其余照常 */
function InlineCodeLink({ className, children }: { className?: string; children?: ReactNode }): JSX.Element {
  const t = useT()
  const openBrowser = useStore((s) => s.openBrowser)
  const previewFile = useStore((s) => s.previewFile)
  const sourceCwd = useContext(MessageSourceCwd)
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.length === 1 && typeof children[0] === 'string' ? children[0] : null
  const candidate = text && !className && !/\s/.test(text.trim()) &&
    (/^(?:[a-zA-Z]:[\\/]|https?:\/\/|file:\/\/)/.test(text.trim()) || /^[\w.@-][^:*?"<>|]*[\\/][^\\/]*\.[a-zA-Z0-9]{1,8}(?::\d+)?$/.test(text.trim()))
    ? classifyLink(text.trim())
    : null
  if (!candidate || candidate.kind === 'invalid') return <code className={className}>{children}</code>
  const open = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (candidate.kind === 'url') void openBrowser(candidate.url)
    else void previewFile(candidate.path, candidate.line, sourceCwd, candidate.lineEnd)
  }
  const openExternally = (e: React.MouseEvent): void => {
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    if (candidate.kind === 'url') void window.yan.browser.openExternal(candidate.url)
    else void window.yan.revealPath(resolveAgainstCwd(candidate.path, sourceCwd))
  }
  return (
    <code className="v3-md-code-link" title={t('link.codeDblclickHint')} onClick={open} onDoubleClick={openExternally}>
      {children}
    </code>
  )
}

/** 给定 pre 节点的子 code 元素，取语言标注 */
function codeLang(node?: HastNode): string | undefined {
  const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = Array.isArray(code?.properties?.className) ? code.properties.className as string[] : []
  return classes.find((c) => c.startsWith('language-'))?.slice('language-'.length)
}

/** 取 hast 节点的纯文本：结构化块（图表/卡片/小部件）重新解析它，而不是解析高亮后的 HTML。 */
const hastText = (node: HastNode): string =>
  node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(hastText).join('')

/**
 * 代码块：语言标签 + 换行切换 + 复制。样式用 `sunken` 底、圆角；
 * 复制读的是已渲染文本，不依赖高亮结果。
 */
function CodeBlock({ lang, children }: { lang?: string; children?: ReactNode }): JSX.Element {
  const t = useT()
  const preRef = useRef<HTMLPreElement>(null)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = (): void => {
    const text = preRef.current?.innerText ?? ''
    void navigator.clipboard.writeText(text).then(
      () => { setFailed(false); setCopied(true); window.setTimeout(() => setCopied(false), 1600) },
      () => { setFailed(true); window.setTimeout(() => setFailed(false), 2000) }
    )
  }
  return (
    <div className="v3-code" data-lang={lang || 'text'}>
      <div className="v3-code-head">
        <span className="v3-code-lang">{lang || 'text'}</span>
        <span className="v3-code-sp" />
        <button
          type="button"
          className="v3-code-act"
          aria-pressed={wrap}
          aria-label={t('sheet.inputNewline')}
          title={t('sheet.inputNewline')}
          onClick={() => setWrap((v) => !v)}
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          type="button"
          className="v3-code-act"
          aria-label={copied ? t('turn.copied') : failed ? t('turn.copyFailed') : t('turn.copy')}
          title={copied ? t('turn.copied') : failed ? t('turn.copyFailed') : t('turn.copy')}
          onClick={copy}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
      <pre ref={preRef} className={wrap ? 'wrap' : undefined}>{children}</pre>
    </div>
  )
}

/**
 * 结构化图块入口：`mermaid` 在会话层单独渲染（主题来自 v3 令牌，深浅随 data-theme），
 * 其余 `yan-*` 结构化图块交给 `VisualFence` 用 v3 组件渲染。
 */
function MarkdownPre({ node, children }: { node?: HastNode; children?: ReactNode }): JSX.Element {
  const t = useT()
  const live = useContext(MarkdownLive)
  const lang = codeLang(node)
  if (lang && isVisualBlockLang(lang)) {
    const fallback = <CodeBlock lang={lang}>{children}</CodeBlock>
    const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
    if (lang === 'mermaid') {
      /* 流式期间源码未写完，先占位；完成后交给 MermaidBlock 渲染。 */
      if (live) return <div className="v3-visual-pending" role="status">{t('vb.pending')}</div>
      return <MermaidBlock source={code ? hastText(code) : ''} fallback={fallback} />
    }
    return (
      <VisualFence
        lang={lang}
        text={code ? hastText(code) : ''}
        live={live}
        fallback={fallback}
        blockId={String(node?.position?.start?.offset ?? '')}
      />
    )
  }
  return <CodeBlock lang={lang}>{children}</CodeBlock>
}

const MD_COMPONENTS: Options['components'] = {
  a: LinkAnchor,
  img: MarkdownImage,
  code: InlineCodeLink,
  pre: MarkdownPre,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="v3-md-table-wrap">
      <table>{children}</table>
    </div>
  )
}

/** 是否停在一个没闭合的代码围栏里（流式中的半截代码块 → 不高亮） */
function hasUnclosedFence(text: string): boolean {
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) n++
  }
  return n % 2 === 1
}

export const Markdown = memo(function Markdown({
  text,
  sourceCwd,
  live = false,
  sessionId,
  messageId
}: {
  text: string
  sourceCwd?: string
  live?: boolean
  /**
   * 可选真实消息身份：调用方明确知道时才传。缺省时内部退到 `useId`
   * 的实例唯一值，**不伪造** sessionId；载入后不会跨消息/跨会话串状态。
   */
  sessionId?: string | null
  messageId?: string | null
}): JSX.Element {
  /* 先让输入与工具状态上屏，再做昂贵的实时 Markdown 工作；完成态用权威文本 */
  const deferredText = useDeferredValue(text)
  const renderedText = live ? deferredText : text
  /* 身份在实例内稳定，流式→完成不更换；缓存正文也要挂在各自 identity provider 下。 */
  const identity = useMarkdownIdentity(sessionId, messageId)

  const cached = live ? undefined : mdCache.get(renderedText)
  if (cached) {
    return (
      <WidgetIdentityContext.Provider value={identity}>
        <MessageSourceCwd.Provider value={sourceCwd}>
          <MarkdownLive.Provider value={false}>{cached}</MarkdownLive.Provider>
        </MessageSourceCwd.Provider>
      </WidgetIdentityContext.Provider>
    )
  }

  const unclosed = hasUnclosedFence(renderedText)
  const plugin = live || unclosed ? MD_REHYPE_PLAIN : MD_REHYPE
  const element = (
    <div className="v3-prose">
      <ReactMarkdown remarkPlugins={MD_REMARK} rehypePlugins={plugin} components={MD_COMPONENTS}>
        {renderedText}
      </ReactMarkdown>
    </div>
  )
  const stable = !live && !unclosed && renderedText.length <= 20_000
  if (stable) mdCacheSet(renderedText, element)
  return (
    <WidgetIdentityContext.Provider value={identity}>
      <MessageSourceCwd.Provider value={sourceCwd}>
        <MarkdownLive.Provider value={live}>{element}</MarkdownLive.Provider>
      </MessageSourceCwd.Provider>
    </WidgetIdentityContext.Provider>
  )
})

/** 简单文本（无 Markdown）也走这里，保持段落间距一致 */
export function PlainText({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean), [text])
  return (
    <div className="v3-prose">
      {parts.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  )
}
