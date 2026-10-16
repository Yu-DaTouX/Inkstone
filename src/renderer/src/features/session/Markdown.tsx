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

const MD_REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm]
const MD_REHYPE: NonNullable<Options['rehypePlugins']> = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]
const MD_REHYPE_PLAIN: NonNullable<Options['rehypePlugins']> = []

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
const MarkdownLive = createContext(false)

type HastNode = { position?: { start?: { offset?: number } }; type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

function resolveAgainstCwd(path: string, cwd?: string): string {
  if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(path) || !cwd) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`
}

function LinkAnchor({ href, children }: { href?: string; children?: ReactNode }): JSX.Element {
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

function codeLang(node?: HastNode): string | undefined {
  const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = Array.isArray(code?.properties?.className) ? code.properties.className as string[] : []
  return classes.find((c) => c.startsWith('language-'))?.slice('language-'.length)
}

const hastText = (node: HastNode): string =>
  node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(hastText).join('')

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

function MarkdownPre({ node, children }: { node?: HastNode; children?: ReactNode }): JSX.Element {
  const t = useT()
  const live = useContext(MarkdownLive)
  const lang = codeLang(node)
  if (lang && isVisualBlockLang(lang)) {
    const fallback = <CodeBlock lang={lang}>{children}</CodeBlock>
    const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
    if (lang === 'mermaid') {
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
  sessionId?: string | null
  messageId?: string | null
}): JSX.Element {
  const deferredText = useDeferredValue(text)
  const renderedText = live ? deferredText : text
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

export function PlainText({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean), [text])
  return (
    <div className="v3-prose">
      {parts.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  )
}
