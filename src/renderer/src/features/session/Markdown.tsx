import { createContext, useContext, memo, startTransition, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ClassAttributes, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink, type LinkTarget } from '../../../../shared/links'
import { fileUrl as toFileUrl } from '../../../../shared/file-url'
import { isVisualBlockLang } from '../../../../shared/visual-blocks'
import { highlightOptions, rehypeHighlight, rehypeMarkOversizedCode } from '../../lib/code-highlight'
import { prefersReducedMotion } from '../../lib/reduced-motion'
import { MessageImage } from './Image'
import { RemoteImage } from './RemoteImage'
import { Icon } from './Icon'
import { VisualFence } from '../artifacts/VisualFence'
import { MermaidBlock } from '../artifacts/MermaidBlock'
import { WidgetIdentityContext, useMarkdownIdentity } from '../artifacts/widget-lifecycle'
import { splitMarkdownBlocks } from './markdown-blocks'
import { rehypeKbd } from './markdown-kbd'
import { useSmoothReveal } from './smooth-reveal'
import { mathLoadState, mathPlugins, needsMath, requestMath, subscribeMath, type MathPlugins } from './markdown-math'
import { fadeSpans, rehypeRevealFade, spansForBlock, trackReveal, type FadeSpan, type FadeTrack } from './reveal-fade'
import { openMessageMenu, type MessageMenuItem } from './message-menu'
import { useSessionText } from './text'
import { CitationLink, useCitation } from './web-search/citations'
import '../../patterns/highlighted-code.css'

type PluginList = NonNullable<Options['rehypePlugins']>

const MD_REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm]
const MD_REHYPE: PluginList = [rehypeKbd, rehypeMarkOversizedCode, [rehypeHighlight, highlightOptions]]
const MD_REHYPE_PLAIN: PluginList = [rehypeKbd]
const NO_FADE: readonly FadeSpan[] = []

const pluginCache = new Map<string, { remark: NonNullable<Options['remarkPlugins']>; rehype: PluginList }>()

function pluginsFor(highlight: boolean, math: MathPlugins | null): { remark: NonNullable<Options['remarkPlugins']>; rehype: PluginList } {
  const key = `${highlight ? 1 : 0}${math ? 1 : 0}`
  let hit = pluginCache.get(key)
  if (!hit) {
    const base = highlight ? MD_REHYPE : MD_REHYPE_PLAIN
    hit = math
      ? { remark: [...MD_REMARK, ...math.remark], rehype: [...math.rehype, ...base] }
      : { remark: MD_REMARK, rehype: base }
    pluginCache.set(key, hit)
  }
  return hit
}

function useMathFor(text: string): { needed: boolean; plugins: MathPlugins | null } {
  const needed = useMemo(() => needsMath(text), [text])
  const state = useSyncExternalStore(subscribeMath, mathLoadState, mathLoadState)
  useEffect(() => {
    if (needed) requestMath()
  }, [needed])
  return { needed, plugins: needed && state === 'ready' ? mathPlugins() : null }
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

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

const NOT_A_LINK: LinkTarget = { kind: 'invalid', reason: 'empty' }

const MessageSourceCwd = createContext<string | undefined>(undefined)
const MarkdownLive = createContext(false)
const MarkdownOffset = createContext(0)

type HastNode = { position?: { start?: { offset?: number } }; type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

function resolveAgainstCwd(path: string, cwd?: string): string {
  if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(path) || !cwd) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`
}

function useLinkMenu(target: LinkTarget, sourceCwd?: string): ((event: React.MouseEvent) => void) | undefined {
  const tt = useSessionText()
  const openLink = useStore((s) => s.openLink)
  const previewFile = useStore((s) => s.previewFile)
  if (target.kind === 'invalid') return undefined
  return (event) => {
    const items: MessageMenuItem[] = target.kind === 'url'
      ? [
          { id: 'open', label: tt('menuOpenLink'), run: () => void openLink(target.url) },
          { id: 'external', label: tt('menuOpenExternal'), run: () => void window.yan.browser.openExternal(target.url) },
          { id: 'copy', label: tt('menuCopyLink'), run: () => copyText(target.url) }
        ]
      : [
          { id: 'preview', label: tt('menuPreviewFile'), run: () => void previewFile(target.path, target.line, sourceCwd, target.lineEnd) },
          { id: 'reveal', label: tt('menuRevealFile'), run: () => void window.yan.revealPath(resolveAgainstCwd(target.path, sourceCwd)) },
          { id: 'copy', label: tt('menuCopyPath'), run: () => copyText(resolveAgainstCwd(target.path, sourceCwd)) }
        ]
    openMessageMenu(event, tt('menuLink'), items)
  }
}

type AnchorProps = ClassAttributes<HTMLAnchorElement> & AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps

function LinkAnchor({ href, children, ...rest }: AnchorProps): JSX.Element {
  const t = useT()
  const openLink = useStore((s) => s.openLink)
  const previewFile = useStore((s) => s.previewFile)
  const citation = useCitation(href)
  const ariaLabel = typeof rest['aria-label'] === 'string' ? rest['aria-label'] : undefined
  const sourceCwd = useContext(MessageSourceCwd)
  const target = classifyLink(href)
  const onContextMenu = useLinkMenu(target, sourceCwd)
  if (citation) return <CitationLink citation={citation} />
  if (typeof href === 'string' && href.startsWith('#')) {
    const anchorId = typeof rest['id'] === 'string' ? rest['id'] : undefined
    const describedBy = typeof rest['aria-describedby'] === 'string' ? rest['aria-describedby'] : undefined
    return (
      <a
        href={href}
        id={anchorId}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className="v3-md-link v3-md-anchor"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    )
  }

  const onClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (target.kind === 'url') void openLink(target.url)
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
      onContextMenu={onContextMenu}
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
    return <RemoteImage src={target.url} alt={alt} className="v3-md-image" />
  }
  const abs = /^[a-zA-Z]:[\\/]|^\//.test(target.path) || !sourceCwd
    ? target.path
    : `${sourceCwd.replace(/[\\/]+$/, '')}/${target.path.replace(/^\.[\\/]/, '')}`
  return <MessageImage src={toFileUrl(abs)} alt={alt} sourceCwd={sourceCwd} className="v3-md-image" />
}

function InlineCodeLink({ className, children }: { className?: string; children?: ReactNode }): JSX.Element {
  const t = useT()
  const openLink = useStore((s) => s.openLink)
  const previewFile = useStore((s) => s.previewFile)
  const sourceCwd = useContext(MessageSourceCwd)
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.length === 1 && typeof children[0] === 'string' ? children[0] : null
  const candidate = text && !className && !/\s/.test(text.trim()) &&
    (/^(?:[a-zA-Z]:[\\/]|https?:\/\/|file:\/\/)/.test(text.trim()) || /^[\w.@-][^:*?"<>|]*[\\/][^\\/]*\.[a-zA-Z0-9]{1,8}(?::\d+)?$/.test(text.trim()))
    ? classifyLink(text.trim())
    : null
  const onContextMenu = useLinkMenu(candidate ?? NOT_A_LINK, sourceCwd)
  if (!candidate || candidate.kind === 'invalid') return <code className={className}>{children}</code>
  const open = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (candidate.kind === 'url') void openLink(candidate.url)
    else void previewFile(candidate.path, candidate.line, sourceCwd, candidate.lineEnd)
  }
  const openExternally = (e: React.MouseEvent): void => {
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    if (candidate.kind === 'url') void window.yan.browser.openExternal(candidate.url)
    else void window.yan.revealPath(resolveAgainstCwd(candidate.path, sourceCwd))
  }
  return (
    <code className="v3-md-code-link" title={t('link.codeDblclickHint')} onClick={open} onDoubleClick={openExternally} onContextMenu={onContextMenu}>
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
  const tt = useSessionText()
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
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
  const onContextMenu = (event: React.MouseEvent): void => {
    const text = (preRef.current?.innerText ?? '').replace(/\n$/, '')
    openMessageMenu(event, tt('menuCode'), [
      { id: 'copy', label: tt('menuCopyCode'), run: () => copyText(text) },
      { id: 'insert', label: tt('menuInsertCode'), run: () => insertIntoComposer(`\`\`\`${lang ?? ''}\n${text}\n\`\`\``) }
    ])
  }
  return (
    <div className="v3-code" data-lang={lang || 'text'} onContextMenu={onContextMenu}>
      <div className="v3-code-head">
        <span className="v3-code-lang">{lang || 'text'}</span>
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
  const offset = useContext(MarkdownOffset)
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
        blockId={node?.position?.start?.offset === undefined ? '' : String(offset + node.position.start.offset)}
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

function footnoteIndex(referenceIndex: number, rereferenceIndex: number): string {
  return `${referenceIndex + 1}${rereferenceIndex > 1 ? `-${rereferenceIndex}` : ''}`
}

function useFootnoteOptions(): NonNullable<Options['remarkRehypeOptions']> {
  const t = useT()
  return useMemo(
    () => ({
      footnoteLabel: t('chat.footnoteTitle'),
      footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number) =>
        t('chat.footnoteBack', { index: footnoteIndex(referenceIndex, rereferenceIndex) })
    }),
    [t]
  )
}

function MarkdownBody({ remark, rehype, text }: { remark: NonNullable<Options['remarkPlugins']>; rehype: PluginList; text: string }): JSX.Element {
  const remarkRehypeOptions = useFootnoteOptions()
  return (
    <ReactMarkdown remarkPlugins={remark} rehypePlugins={rehype} components={MD_COMPONENTS} remarkRehypeOptions={remarkRehypeOptions}>
      {text}
    </ReactMarkdown>
  )
}

function hasUnclosedFence(text: string): boolean {
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) n++
  }
  return n % 2 === 1
}

const FENCE_LINE = /^\s*(```|~~~)/m
const CROSS_BLOCK_REFERENCE = /^ {0,3}\[[^\]]+\]:\s*\S/m

const LiveMarkdownBlock = memo(function LiveMarkdownBlock({ text, offset, highlight, math, fade }: { text: string; offset: number; highlight: boolean; math: MathPlugins | null; fade: readonly FadeSpan[] }): JSX.Element {
  const plugins = pluginsFor(highlight, math)
  const rehype = fade.length ? [...plugins.rehype, [rehypeRevealFade, { spans: fade }]] as PluginList : plugins.rehype
  return (
    <MarkdownOffset.Provider value={offset}>
      <MarkdownBody remark={plugins.remark} rehype={rehype} text={text} />
    </MarkdownOffset.Provider>
  )
})

function LiveMarkdown({ text, highlight = false, math = null, fade = NO_FADE }: { text: string; highlight?: boolean; math?: MathPlugins | null; fade?: readonly FadeSpan[] }): JSX.Element {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text])
  return (
    <div className="v3-prose">
      {blocks.map((block) => {
        const spans = fade.length ? spansForBlock(fade, block.offset, block.text.length) : NO_FADE
        return (
          <LiveMarkdownBlock
            key={block.offset}
            text={block.text}
            offset={block.offset}
            highlight={highlight && FENCE_LINE.test(block.text)}
            math={math}
            fade={spans.length ? spans : NO_FADE}
          />
        )
      })}
    </div>
  )
}

function useRevealFade(text: string, live: boolean): readonly FadeSpan[] {
  const track = useRef<FadeTrack | null>(null)
  if (!live || prefersReducedMotion()) {
    track.current = null
    return NO_FADE
  }
  const now = performance.now()
  track.current = trackReveal(track.current, text, now)
  const spans = fadeSpans(track.current, now)
  return spans.length ? spans : NO_FADE
}

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout: 500 })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(callback, 50)
  return () => window.clearTimeout(handle)
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
  const revealedText = useSmoothReveal(text, live)
  const deferredText = useDeferredValue(revealedText)
  const renderedText = live ? deferredText : text
  const { lang } = useI18n()
  const footnoteOptions = useFootnoteOptions()
  const fade = useRevealFade(renderedText, live)
  const math = useMathFor(renderedText)
  const identity = useMarkdownIdentity(sessionId, messageId)
  const wasLive = useRef(false)
  if (live) wasLive.current = true
  const settling = !live && wasLive.current
  const [highlightReady, setHighlightReady] = useState(false)
  useEffect(() => {
    if (!settling) {
      setHighlightReady(false)
      return undefined
    }
    return whenIdle(() => startTransition(() => setHighlightReady(true)))
  }, [settling])

  const mathPending = math.needed && !math.plugins
  const cacheKey = `${lang}|${math.plugins ? `math:${renderedText}` : renderedText}`
  const cached = live || mathPending ? undefined : mdCache.get(cacheKey)
  if (cached) {
    return (
      <WidgetIdentityContext.Provider value={identity}>
        <MessageSourceCwd.Provider value={sourceCwd}>
          <MarkdownLive.Provider value={false}>{cached}</MarkdownLive.Provider>
        </MessageSourceCwd.Provider>
      </WidgetIdentityContext.Provider>
    )
  }

  if (live) {
    return (
      <WidgetIdentityContext.Provider value={identity}>
        <MessageSourceCwd.Provider value={sourceCwd}>
          <MarkdownLive.Provider value>
            <LiveMarkdown text={renderedText} math={math.plugins} fade={fade} />
          </MarkdownLive.Provider>
        </MessageSourceCwd.Provider>
      </WidgetIdentityContext.Provider>
    )
  }

  const unclosed = hasUnclosedFence(renderedText)
  if (settling && !CROSS_BLOCK_REFERENCE.test(renderedText)) {
    return (
      <WidgetIdentityContext.Provider value={identity}>
        <MessageSourceCwd.Provider value={sourceCwd}>
          <MarkdownLive.Provider value={false}>
            <LiveMarkdown text={renderedText} highlight={highlightReady && !unclosed} math={math.plugins} />
          </MarkdownLive.Provider>
        </MessageSourceCwd.Provider>
      </WidgetIdentityContext.Provider>
    )
  }
  const plugins = pluginsFor(!unclosed, math.plugins)
  const element = (
    <div className="v3-prose">
      <ReactMarkdown remarkPlugins={plugins.remark} rehypePlugins={plugins.rehype} components={MD_COMPONENTS} remarkRehypeOptions={footnoteOptions}>
        {renderedText}
      </ReactMarkdown>
    </div>
  )
  const stable = !unclosed && !mathPending && renderedText.length <= 20_000
  if (stable) mdCacheSet(cacheKey, element)
  return (
    <WidgetIdentityContext.Provider value={identity}>
      <MessageSourceCwd.Provider value={sourceCwd}>
        <MarkdownLive.Provider value={live}>{element}</MarkdownLive.Provider>
      </MessageSourceCwd.Provider>
    </WidgetIdentityContext.Provider>
  )
})
