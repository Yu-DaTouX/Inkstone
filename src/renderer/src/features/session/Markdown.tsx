import { createContext, Fragment, useContext, memo, startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ClassAttributes, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { CircleDot, Folder, FolderGit2, GitCommitHorizontal, GitPullRequest, SquareTerminal, WrapText } from 'lucide-react'
import { Button, IconButton } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
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
import { prepareStreamingMarkdown, splitMarkdownBlocks } from './markdown-blocks'
import { markdownCacheKey } from './markdown-cache-key'
import { throttleTail, type TailHold } from './markdown-tail-throttle'
import { rehypeKbd } from './markdown-kbd'
import { useSmoothReveal } from './smooth-reveal'
import { mathLoadState, mathPlugins, needsMath, requestMath, subscribeMath, type MathPlugins } from './markdown-math'
import { fadeSpans, rehypeRevealFade, spansForBlock, trackReveal, type FadeSpan, type FadeTrack } from './reveal-fade'
import { openMessageMenu, type MessageMenuItem } from './message-menu'
import { useSessionText } from './text'
import { CitationLink, useCitation } from './web-search/citations'
import { fillTerminalCommand, terminalCommandOf } from '../terminal/terminal-fill'
import { currentWorkspaceOwner } from '../workbench/use-owner'
import '../../patterns/highlighted-code.css'

type PluginList = NonNullable<Options['rehypePlugins']>

const MD_REMARK: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkCjkFriendly]
const MD_REHYPE: PluginList = [rehypeKbd, rehypeMarkOversizedCode, [rehypeHighlight, highlightOptions]]
const MD_REHYPE_PLAIN: PluginList = [rehypeKbd]
const MD_HTML_SCHEMA = { ...defaultSchema, tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== 'source') }
const MD_REHYPE_HTML: PluginList = [rehypeRaw, [rehypeSanitize, MD_HTML_SCHEMA]]
const NO_FADE: readonly FadeSpan[] = []

const pluginCache = new Map<string, { remark: NonNullable<Options['remarkPlugins']>; rehype: PluginList }>()

function pluginsFor(highlight: boolean, math: MathPlugins | null, html = false): { remark: NonNullable<Options['remarkPlugins']>; rehype: PluginList } {
  const key = `${highlight ? 1 : 0}${math ? 1 : 0}${html ? 1 : 0}`
  let hit = pluginCache.get(key)
  if (!hit) {
    const lead: PluginList = html ? MD_REHYPE_HTML : []
    const base = highlight ? MD_REHYPE : MD_REHYPE_PLAIN
    hit = math
      ? { remark: [...MD_REMARK, ...math.remark], rehype: [...lead, ...math.rehype, ...base] }
      : { remark: MD_REMARK, rehype: html ? [...lead, ...base] : base }
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

const MD_CACHE_LIMIT = 200
const MD_CACHE_TOTAL_CHARS = 1_000_000
const MD_CACHE_ENTRY_CHARS = 200_000
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
const MarkdownHtml = createContext(false)

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

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+(\/(pull|issues|commit)\/)?/i

function GithubLinkIcon({ url }: { url: string }): JSX.Element | null {
  const match = GITHUB_URL.exec(url)
  if (!match) return null
  const Glyph = match[2] === 'pull' ? GitPullRequest : match[2] === 'issues' ? CircleDot : match[2] === 'commit' ? GitCommitHorizontal : FolderGit2
  return <Glyph size={13} strokeWidth={1.75} className="v3-md-link-icon" aria-hidden />
}

function FileLinkIcon({ path }: { path: string }): JSX.Element {
  if (/[\\/]$/.test(path)) return <Folder size={13} strokeWidth={1.75} className="v3-md-link-icon" aria-hidden />
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return <FileTypeIcon name={base} size={14} className="v3-md-link-icon" />
}

const PATH_STAT_LIMIT = 2000
const pathStats = new Map<string, string | null | Promise<string | null>>()

function statKnown(path: string, cwd?: string): Promise<string | null> {
  const key = `${cwd ?? ''}|${path}`
  const hit = pathStats.get(key)
  if (hit !== undefined && !(hit instanceof Promise)) return Promise.resolve(hit)
  if (hit) return hit
  if (pathStats.size > PATH_STAT_LIMIT) pathStats.clear()
  const stat = window.yan?.statPreview
  const pending = (typeof stat === 'function' ? stat(path, cwd).then((result) => (result.ok ? result.abs || path : null), () => null) : Promise.resolve(null))
    .then((abs) => {
      pathStats.set(key, abs)
      return abs
    })
  pathStats.set(key, pending)
  return pending
}

function useResolvedPath(path: string | null, cwd?: string): string | null {
  const key = path ? `${cwd ?? ''}|${path}` : ''
  const known = key ? pathStats.get(key) : undefined
  const settled = known !== undefined && !(known instanceof Promise)
  const [resolved, setResolved] = useState<{ key: string; abs: string | null } | null>(null)
  useEffect(() => {
    if (!path || settled) return undefined
    let alive = true
    void statKnown(path, cwd).then((abs) => {
      if (alive) setResolved({ key, abs })
    })
    return () => { alive = false }
  }, [key, settled, path, cwd])
  if (settled) return known as string | null
  return resolved?.key === key ? resolved.abs : null
}

function pathPieces(children: ReactNode): ReactNode {
  if (typeof children !== 'string' || /\s/.test(children) || !/[\\/]./.test(children)) return children
  const parts = children.split(/(?<=[\\/])/)
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index ? <wbr /> : null}
      <span className="v3-md-path-part">{part}</span>
    </Fragment>
  ))
}

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

  const label = textOf(children).trim()
  const title =
    target.kind === 'file'
      ? (() => {
          const full = resolveAgainstCwd(target.path, sourceCwd)
          return target.line ? `${full}:${target.line}${target.lineEnd ? `-${target.lineEnd}` : ''}` : full
        })()
      : target.kind === 'invalid'
        ? t('link.blocked')
        : target.url

  return (
    <a
      href={target.kind === 'url' ? target.url : '#'}
      className={`v3-md-link ${target.kind === 'invalid' ? 'blocked' : ''}`}
      data-link-kind={target.kind}
      data-short={label.length <= SHORT_LINK_CHARS ? '' : undefined}
      data-github={target.kind === 'url' && GITHUB_URL.test(target.url) ? '' : undefined}
      data-line={target.kind === 'file' && target.line ? String(target.line) : undefined}
      data-line-end={target.kind === 'file' && target.lineEnd ? String(target.lineEnd) : undefined}
      title={target.kind === 'invalid' ? title : `${title}\n${t('link.dblclickHint')}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onAuxClick={(e) => e.preventDefault()}
      onContextMenu={onContextMenu}
    >
      {target.kind === 'file' ? <><FileLinkIcon path={target.path} />{'\u2060'}</> : target.kind === 'url' && GITHUB_URL.test(target.url) ? <><GithubLinkIcon url={target.url} />{'\u2060'}</> : null}
      {children}
    </a>
  )
}

const SHORT_LINK_CHARS = 24

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
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
  const resolved = useResolvedPath(candidate?.kind === 'file' ? candidate.path : null, sourceCwd)
  if (!candidate || candidate.kind === 'invalid' || (candidate.kind === 'file' && !resolved)) return <code className={className}>{className ? children : pathPieces(children)}</code>
  const open = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (candidate.kind === 'url') void openLink(candidate.url)
    else void previewFile(candidate.path, candidate.line, sourceCwd, candidate.lineEnd)
  }
  const openExternally = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.getSelection()?.removeAllRanges()
    if (candidate.kind === 'url') void window.yan.browser.openExternal(candidate.url)
    else void window.yan.revealPath(resolveAgainstCwd(candidate.path, sourceCwd))
  }
  return (
    <code className="v3-md-code-link" role="link" tabIndex={0} title={candidate.kind === 'file' && resolved ? `${resolved}\n${t('link.codeDblclickHint')}` : t('link.codeDblclickHint')} onClick={open} onDoubleClick={openExternally} onContextMenu={onContextMenu} onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      if (candidate.kind === 'url') void openLink(candidate.url)
      else void previewFile(candidate.path, candidate.line, sourceCwd, candidate.lineEnd)
    }}>
      {pathPieces(children)}
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

function CodeBlock({ lang, source, children }: { lang?: string; source: string; children?: ReactNode }): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
  const sourceCwd = useContext(MessageSourceCwd)
  const identity = useContext(WidgetIdentityContext)
  const live = useContext(MarkdownLive)
  const readable = !lang || /^(?:md|markdown|text|txt|plain|plaintext)$/i.test(lang)
  const [reading, setReading] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(source).then(
      () => { setFailed(false); setCopied(true); window.setTimeout(() => setCopied(false), 1600) },
      () => { setFailed(true); window.setTimeout(() => setFailed(false), 2000) }
    )
  }
  const command = live || typeof window.yan?.terminal?.write !== 'function' ? null : terminalCommandOf(lang, source)
  const fillTerminal = (): void => {
    if (!command) return
    void fillTerminalCommand(currentWorkspaceOwner().key, command).then((result) => {
      if (result === 'filled') return
      copyText(command)
      useStore.getState().notify('warning', t(result === 'busy' ? 'code.terminalBusy' : 'code.terminalFailed'))
    })
  }
  const onContextMenu = (event: React.MouseEvent): void => {
    const text = source.replace(/\n$/, '')
    openMessageMenu(event, tt('menuCode'), [
      { id: 'copy', label: tt('menuCopyCode'), run: () => copyText(text) },
      { id: 'insert', label: tt('menuInsertCode'), run: () => insertIntoComposer(`\`\`\`${lang ?? ''}\n${text}\n\`\`\``) },
      ...(command ? [{ id: 'terminal', label: t('code.toTerminal'), run: fillTerminal }] : [])
    ])
  }
  return (
    <div className="v3-code" data-lang={lang || 'text'} onContextMenu={onContextMenu}>
      <div className="v3-code-head">
        <span className="v3-code-lang">{lang || 'text'}</span>
        <span className="v3-code-sp" />
        {readable ? (
          <Button variant="ghost" size="sm" aria-pressed={reading} onPress={() => setReading((v) => !v)}>
            {t(reading ? 'code.source' : 'code.reading')}
          </Button>
        ) : null}
        <IconButton
          variant="ghost"
          size="sm"
          className="v3-code-act"
          aria-pressed={wrap}
          aria-label={t('code.wrap')}
          tooltip={t('code.wrap')}
          isDisabled={reading}
          onPress={() => setWrap((v) => !v)}
        >
          <WrapText size={14} aria-hidden />
        </IconButton>
        {command ? (
          <IconButton
            variant="ghost"
            size="sm"
            className="v3-code-act"
            aria-label={t('code.toTerminal')}
            tooltip={t('code.toTerminalHint')}
            onPress={fillTerminal}
            data-testid="code-to-terminal"
          >
            <SquareTerminal size={14} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton
          variant="ghost"
          size="sm"
          className="v3-code-act"
          aria-label={copied ? t('turn.copied') : failed ? t('turn.copyFailed') : t('turn.copy')}
          tooltip={copied ? t('turn.copied') : failed ? t('turn.copyFailed') : t('turn.copy')}
          onPress={copy}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </IconButton>
      </div>
      {reading ? (
        <div className="v3-code-reading">
          <Markdown text={source} sourceCwd={sourceCwd} live={live} sessionId={identity?.sessionId} messageId={identity?.messageId} />
        </div>
      ) : <pre className={wrap ? 'wrap' : undefined}>{children}</pre>}
    </div>
  )
}

function MarkdownPre({ node, children }: { node?: HastNode; children?: ReactNode }): JSX.Element {
  const t = useT()
  const live = useContext(MarkdownLive)
  const offset = useContext(MarkdownOffset)
  const lang = codeLang(node)
  const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
  const source = code ? hastText(code) : ''
  if (lang && isVisualBlockLang(lang)) {
    const fallback = <CodeBlock lang={lang} source={source}>{children}</CodeBlock>
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
  return <CodeBlock lang={lang} source={source}>{children}</CodeBlock>
}

function isLeadParagraph(node?: HastNode): boolean {
  const kids = (node?.children ?? []).filter((child) => !(child.type === 'text' && !(child.value ?? '').trim()))
  if (kids.length !== 1 || kids[0].type !== 'element' || kids[0].tagName !== 'strong') return false
  const label = hastText(kids[0]).trim()
  return label.length > 0 && label.length <= LEAD_MAX_CHARS && !/[\u3002\uff01\uff1f.!?]$/.test(label)
}

const LEAD_MAX_CHARS = 32

function MarkdownParagraph({ node, children }: { node?: HastNode; children?: ReactNode }): JSX.Element {
  return <p data-lead={isLeadParagraph(node) ? '' : undefined}>{children}</p>
}

const MD_COMPONENTS: Options['components'] = {
  a: LinkAnchor,
  p: MarkdownParagraph,
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
  const plugins = pluginsFor(highlight, math, useContext(MarkdownHtml))
  const rehype = fade.length ? [...plugins.rehype, [rehypeRevealFade, { spans: fade }]] as PluginList : plugins.rehype
  const live = useContext(MarkdownLive)
  return (
    <MarkdownOffset.Provider value={offset}>
      <MarkdownLive.Provider value={live && hasUnclosedFence(text)}>
        <MarkdownBody remark={plugins.remark} rehype={rehype} text={text} />
      </MarkdownLive.Provider>
    </MarkdownOffset.Provider>
  )
})

function LiveMarkdown({ text, highlight = false, math = null, fade = NO_FADE, throttle = false }: { text: string; highlight?: boolean; math?: MathPlugins | null; fade?: readonly FadeSpan[]; throttle?: boolean }): JSX.Element {
  const split = useMemo(() => splitMarkdownBlocks(text), [text])
  const hold = useRef<TailHold | null>(null)
  const [, retry] = useState(0)
  let blocks = split
  let wait = 0
  const tail = split[split.length - 1]
  if (throttle && tail) {
    const result = throttleTail(hold.current, tail, performance.now())
    hold.current = result.hold
    wait = result.wait
    if (result.text !== tail.text) blocks = [...split.slice(0, -1), { ...tail, text: result.text }]
  } else {
    hold.current = null
  }
  useEffect(() => {
    if (wait <= 0) return undefined
    const id = window.setTimeout(() => retry((n) => n + 1), wait)
    return () => window.clearTimeout(id)
  }, [wait, text])
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
  messageId,
  allowHtml = false
}: {
  text: string
  sourceCwd?: string
  live?: boolean
  sessionId?: string | null
  messageId?: string | null
  allowHtml?: boolean
}): JSX.Element {
  const sessionCwd = useStore((s) => sessionId
    ? s.sessionRuntimes[sessionId]?.session?.cwd ?? s.sessions.find((item) => item.id === sessionId)?.cwd ?? (s.session?.sessionId === sessionId ? s.session.cwd : undefined)
    : s.session?.cwd)
  sourceCwd = sourceCwd || sessionCwd
  const revealedText = useSmoothReveal(text, live)
  const renderedText = prepareStreamingMarkdown(live ? revealedText : text, live)
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
  const cacheKey = markdownCacheKey({ lang, allowHtml, math: !!math.plugins, text: renderedText })
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

  const unclosed = hasUnclosedFence(renderedText)
  if (live || unclosed) {
    return (
      <WidgetIdentityContext.Provider value={identity}>
        <MessageSourceCwd.Provider value={sourceCwd}>
          <MarkdownLive.Provider value>
            <MarkdownHtml.Provider value={allowHtml}>
              <LiveMarkdown text={renderedText} math={math.plugins} fade={fade} throttle={live} />
            </MarkdownHtml.Provider>
          </MarkdownLive.Provider>
        </MessageSourceCwd.Provider>
      </WidgetIdentityContext.Provider>
    )
  }

  if (settling && !CROSS_BLOCK_REFERENCE.test(renderedText)) {
    return (
      <WidgetIdentityContext.Provider value={identity}>
        <MessageSourceCwd.Provider value={sourceCwd}>
          <MarkdownLive.Provider value={false}>
            <MarkdownHtml.Provider value={allowHtml}>
              <LiveMarkdown text={renderedText} highlight={highlightReady && !unclosed} math={math.plugins} />
            </MarkdownHtml.Provider>
          </MarkdownLive.Provider>
        </MessageSourceCwd.Provider>
      </WidgetIdentityContext.Provider>
    )
  }
  const plugins = pluginsFor(!unclosed, math.plugins, allowHtml)
  const element = (
    <div className="v3-prose">
      <ReactMarkdown remarkPlugins={plugins.remark} rehypePlugins={plugins.rehype} components={MD_COMPONENTS} remarkRehypeOptions={footnoteOptions}>
        {renderedText}
      </ReactMarkdown>
    </div>
  )
  const stable = !unclosed && !mathPending && renderedText.length <= MD_CACHE_ENTRY_CHARS
  if (stable) mdCacheSet(cacheKey, element)
  return (
    <WidgetIdentityContext.Provider value={identity}>
      <MessageSourceCwd.Provider value={sourceCwd}>
        <MarkdownLive.Provider value={live}>{element}</MarkdownLive.Provider>
      </MessageSourceCwd.Provider>
    </WidgetIdentityContext.Provider>
  )
})
