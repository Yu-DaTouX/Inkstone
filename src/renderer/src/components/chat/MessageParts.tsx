import { createContext, createElement, memo, useContext, useDeferredValue, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'
import type { UIToolCall } from '../../../../shared/ipc'
import { fileUrl as toFileUrl } from '../../../../shared/file-url'
import { ChatImage } from './ChatImage'
import { VisualFence } from './VisualBlock'
import { isVisualBlockLang } from '../../../../shared/visual-blocks'
import { createArrivalTracker, markArrivalBlocks, type ArrivalNode, type ArrivalDecision, type ArrivalTracker } from '../../lib/stream-arrival'
import { prefersReducedMotion } from '../../lib/usePresence'

const MD_REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm]
const MD_REHYPE: NonNullable<Options['rehypePlugins']> = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }]
]
const MD_REHYPE_PLAIN: NonNullable<Options['rehypePlugins']> = []

const MD_CACHE_LIMIT = 80
const MD_CACHE_MAX_CHARS = 20_000
const MD_CACHE_TOTAL_CHARS = 120_000
const mdCache = new Map<string, React.ReactElement>()
let mdCacheChars = 0
const mdCacheSet = (text: string, element: React.ReactElement): void => {
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
const MarkdownLive = createContext(false)
const ArrivalTrackerContext = createContext<ArrivalTracker | null>(null)

type ArrivingTag = 'p' | 'ul' | 'ol' | 'blockquote' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

function useArrival(node?: HastNode): { className?: string; style?: CSSProperties } {
  const live = useContext(MarkdownLive)
  const tracker = useContext(ArrivalTrackerContext)
  const key = node?.position?.start?.offset
  const decided = useRef<ArrivalDecision | null>(null)
  if (decided.current === null && tracker && key !== undefined && node?.properties?.['data-arrival-block'] === true) {
    decided.current = tracker.decide(String(key), { live })
  }
  const decision = decided.current
  if (!live || node?.properties?.['data-arrival-block'] !== true || !decision?.animate) return {}
  return { className: 'md-arrive', style: { '--i': decision.stagger } as CSSProperties }
}

function ArrivingBlock({
  tag,
  node,
  className,
  style,
  children,
  ...rest
}: {
  tag: ArrivingTag
  node?: HastNode
  className?: string
  style?: CSSProperties
  children?: React.ReactNode
} & Record<string, unknown>) {
  const arrival = useArrival(node)
  const merged = [className, arrival.className].filter(Boolean).join(' ')
  const mergedStyle = arrival.style ? { ...style, ...arrival.style } : style
  return createElement(
    tag,
    { ...rest, ...(merged ? { className: merged } : {}), ...(mergedStyle ? { style: mergedStyle } : {}) },
    children
  )
}

const MD_COMPONENTS: Options['components'] = {
  a: LinkAnchor,
  img: MarkdownImage,
  code: InlineCodeLink,
  pre: MarkdownPre,
  p: (props) => <ArrivingBlock tag="p" {...props} />,
  ul: (props) => <ArrivingBlock tag="ul" {...props} />,
  ol: (props) => <ArrivingBlock tag="ol" {...props} />,
  blockquote: (props) => <ArrivingBlock tag="blockquote" {...props} />,
  h1: (props) => <ArrivingBlock tag="h1" {...props} />,
  h2: (props) => <ArrivingBlock tag="h2" {...props} />,
  h3: (props) => <ArrivingBlock tag="h3" {...props} />,
  h4: (props) => <ArrivingBlock tag="h4" {...props} />,
  h5: (props) => <ArrivingBlock tag="h5" {...props} />,
  h6: (props) => <ArrivingBlock tag="h6" {...props} />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  )
}

function LinkAnchor({ href, children }: { href?: string; children?: React.ReactNode }) {
  const t = useT()
  const openBrowser = useStore((s) => s.openBrowser)
  const previewFile = useStore((s) => s.previewFile)
  const sourceCwd = useContext(MessageSourceCwd)

  const target = classifyLink(href)

  const onClick = (e: React.MouseEvent): void => {
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
      ? t('link.preview', {
          path: target.line
            ? `${target.path}:${target.line}${target.lineEnd ? `-${target.lineEnd}` : ''}`
            : target.path
        })
      : target.kind === 'invalid'
        ? t('link.blocked')
        : target.url

  return (
    <a
      href={target.kind === 'url' ? target.url : '#'}
      className={`md-link ${target.kind === 'invalid' ? 'blocked' : ''}`}
      data-link-kind={target.kind}
      data-line={target.kind === 'file' && target.line ? String(target.line) : undefined}
      data-line-end={target.kind === 'file' && target.lineEnd ? String(target.lineEnd) : undefined}
      title={target.kind === 'invalid' ? title : `${title}
${t('link.dblclickHint')}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  )
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const sourceCwd = useContext(MessageSourceCwd)
  const target = classifyLink(src)
  if (target.kind === 'invalid') return alt ? <span className="md-image-alt">{alt}</span> : null
  if (target.kind === 'url') {
    if (!/^https?:/i.test(target.url)) return null
    return <ChatImage src={target.url} alt={alt} className="md-image" />
  }
  const abs = /^[a-zA-Z]:[\\/]|^\//.test(target.path) || !sourceCwd
    ? target.path
    : `${sourceCwd.replace(/[\\/]+$/, '')}/${target.path.replace(/^\.[\\/]/, '')}`
  return <ChatImage src={toFileUrl(abs)} alt={alt} sourceCwd={sourceCwd} className="md-image" />
}

function InlineCodeLink({ className, children }: { className?: string; children?: React.ReactNode }) {
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
    <code className="md-code-link" title={t('link.codeDblclickHint')} onClick={open} onDoubleClick={openExternally}>
      {children}
    </code>
  )
}

type HastNode = { position?: { start?: { offset?: number } }; type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }
const hastText = (node: HastNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(hastText).join('')

function MarkdownPre({ node, children }: { node?: HastNode; children?: React.ReactNode }) {
  const live = useContext(MarkdownLive)
  const arrival = useArrival(node)
  const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = Array.isArray(code?.properties?.className) ? code.properties.className as string[] : []
  const lang = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length)
  const plain = <pre className={arrival.className} style={arrival.style}>{children}</pre>
  if (!code || !isVisualBlockLang(lang)) return plain
  return <VisualFence blockId={String(node?.position?.start?.offset ?? '')} lang={lang} text={hastText(code)} live={live} fallback={plain} />
}

function resolveAgainstCwd(path: string, cwd?: string): string {
  if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(path) || !cwd) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`
}

function hasUnclosedFence(text: string): boolean {
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) n++
  }
  return n % 2 === 1
}

export const Markdown = memo(function Markdown({ text, sourceCwd, live = false }: { text: string; sourceCwd?: string; live?: boolean }) {
  const deferredText = useDeferredValue(text)
  const renderedText = live ? deferredText : text
  const arrivalTracker = useRef<ArrivalTracker | null>(null)
  if (arrivalTracker.current === null) arrivalTracker.current = createArrivalTracker()
  const tracker = arrivalTracker.current
  const arrivalRehype = useMemo(() => {
    if (!live) return { code: MD_REHYPE, plain: MD_REHYPE_PLAIN }
    const markBlocks = () => (tree: unknown): void => {
      tracker.observe(markArrivalBlocks(tree as ArrivalNode), { live: true, motion: !prefersReducedMotion() })
    }
    return { code: [markBlocks, ...MD_REHYPE], plain: [markBlocks, ...MD_REHYPE_PLAIN] }
  }, [tracker, live])
  useEffect(() => {
    arrivalTracker.current?.commit()
  })

  const cached = live ? undefined : mdCache.get(renderedText)
  if (cached) return <MessageSourceCwd.Provider value={sourceCwd}><MarkdownLive.Provider value={false}>{cached}</MarkdownLive.Provider></MessageSourceCwd.Provider>

  const unclosed = hasUnclosedFence(renderedText)
  const el = (
    <div className="prose md">
      <ReactMarkdown
        remarkPlugins={MD_REMARK}
        rehypePlugins={live || unclosed ? arrivalRehype.plain : arrivalRehype.code}
        components={MD_COMPONENTS}
      >
        {renderedText}
      </ReactMarkdown>
    </div>
  )

  if (!live && !unclosed && renderedText.length <= MD_CACHE_MAX_CHARS) {
    mdCacheSet(renderedText, el)
  }
  return (
    <MessageSourceCwd.Provider value={sourceCwd}>
      <MarkdownLive.Provider value={live}>
        <ArrivalTrackerContext.Provider value={arrivalTracker.current}>{el}</ArrivalTrackerContext.Provider>
      </MarkdownLive.Provider>
    </MessageSourceCwd.Provider>
  )
})

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

  if (out.length === 0 && (typeof a.oldText === 'string' || typeof a.newText === 'string')) {
    out.push({ oldText: String(a.oldText ?? ''), newText: String(a.newText ?? '') })
  }
  if (out.length === 0 && (typeof a.old_string === 'string' || typeof a.new_string === 'string')) {
    out.push({ oldText: String(a.old_string ?? ''), newText: String(a.new_string ?? '') })
  }

  return out
}

export function ToolDetail({ call }: { call: UIToolCall }) {
  const t = useT()
  const a = (call.args ?? {}) as Record<string, unknown>

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

  if (call.name === 'write' && typeof a.content === 'string') {
    return (
      <>
        {typeof a.path === 'string' ? (
          <div className="tool-path" title={a.path}>
            {a.path}
          </div>
        ) : null}
        <pre className="diff-pre write-body">{a.content}</pre>
        {call.output ? <div className="tool-result">{call.output}</div> : null}
      </>
    )
  }

  const onlyCommand = typeof a.command === 'string' && Object.keys(a).every((k) => k === 'command' || k === 'timeout')
  const onlyScript = typeof a.code === 'string' && Object.keys(a).every((k) => k === 'code' || k === 'timeout_ms')
  const argsText = onlyCommand ? '' : onlyScript ? String(a.code) : call.args && Object.keys(a).length ? JSON.stringify(call.args, null, 2) : call.argsRaw

  return (
    <>
      {onlyScript && argsText ? <pre className="tool-pre code">{argsText}</pre> : null}
      {call.output ? <pre className="tool-pre out">{call.output}</pre> : null}
      {!call.output && call.status === 'ok' ? <div className="tool-empty">{t('tool.noOutput')}</div> : null}
      {!onlyScript && argsText ? <details className="ui-disclosure tool-args">
        <summary>{t('tool.rawArgs')}</summary>
        <pre className="tool-pre args">{argsText}</pre>
      </details> : null}
    </>
  )
}
