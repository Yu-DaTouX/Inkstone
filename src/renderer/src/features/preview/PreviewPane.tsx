import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Copy, FileText, FolderOpen, Image as ImageIcon, ExternalLink, RefreshCw, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { EmptyState, IconButton, Notice, PaneHeader, Skeleton } from '../../ui'
import { OFFICE_MAX_LINES, type OfficeDocumentView } from '../../../../shared/office'
import type { AssistantArtifact, FilePreview } from '../../../../shared/ipc'
import { filePreviewUrl } from '../../lib/file-preview-url'
import { ownerOwnsSession, ownerScopedRead, previewKindOf } from '../artifacts/model'
import { previewTabLabel } from '../workbench/preview-state'
import { usePreviewBindings, usePreviewTabs } from '../workbench/tool-tiles'
import type { PreviewPaneProps } from '../workbench/types'
import { previewText, type PreviewText } from './preview-text'
import { usePreviewFreshness } from './use-preview-freshness'
import {
  dropPreviewSelection,
  previewBaseName,
  previewScopeKey,
  previewViewKey,
  recordPreviewSelection,
  resolvePreviewPath,
  type PreviewSelectionEntry
} from './preview-selection'
import './preview.css'

const MAX_RENDER_LINES = 2000

type PreviewView =
  | { kind: 'empty' }
  | { kind: 'loading'; name: string }
  | { kind: 'text'; name: string; abs: string; text: string; truncated: boolean; windowStart?: number; windowEnd?: number }
  | { kind: 'image'; name: string; abs: string }
  | { kind: 'office'; name: string; abs: string; view: OfficeDocumentView }
  | { kind: 'binary'; name: string; abs: string; bytes: number }
  | { kind: 'error'; name: string; message: string }

export function PreviewPane({ owner, path }: PreviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = previewText(lang)
  const [viewSlot, setViewSlot] = useState<{ key: string; view: PreviewView } | null>(null)
  const [diskStat, setDiskStat] = useState<{ key: string; abs: string; mtimeMs?: number; size?: number } | null>(null)
  const [reload, setReload] = useState(0)
  const [selections, setSelections] = useState<ReadonlyMap<string, PreviewSelectionEntry>>(() => new Map())
  const previewTabs = usePreviewTabs(owner.key)

  const scopeKey = previewScopeKey(owner)
  const externalPath = path ?? null
  const resolved = resolvePreviewPath(selections.get(scopeKey), externalPath)
  if (resolved.externalChanged) {
    setSelections((prev) => dropPreviewSelection(prev, scopeKey))
  }
  const activePath = resolved.path
  const viewKey = previewViewKey(scopeKey, activePath, reload)
  const ownerKeyRef = useRef(owner.key)
  ownerKeyRef.current = owner.key

  const storeSessionId = useStore((store) => store.session?.sessionId)
  const messages = useStore((store) => store.messages)
  const ownsCurrent = ownerOwnsSession(owner, storeSessionId ?? null)
  const artifacts = useMemo<AssistantArtifact[]>(
    () => (ownsCurrent ? messages.flatMap((message) => message.artifacts ?? []) : []),
    [ownsCurrent, messages]
  )

  useEffect(() => {
    if (!activePath || !viewKey) {
      setViewSlot(null)
      return undefined
    }
    const expectedKey = owner.key
    const expectedViewKey = viewKey
    const cwd = owner.cwd
    const name = previewBaseName(activePath)
    let cancelled = false
    const run = async (): Promise<void> => {
      const scoped = await ownerScopedRead<FilePreview>({
        expectedKey,
        currentKey: () => ownerKeyRef.current,
        read: () => window.yan.readPreview(activePath, undefined, cwd)
      })
      if (cancelled) return
      if (!scoped.ok) {
        setViewSlot({ key: expectedViewKey, view: { kind: 'error', name, message: text.failed } })
        return
      }
      const result = scoped.value
      if (!result.ok) {
        setViewSlot({ key: expectedViewKey, view: { kind: 'error', name: result.name || name, message: result.error || text.failed } })
        return
      }
      if (!cancelled) {
        setDiskStat({ key: expectedViewKey, abs: result.abs, mtimeMs: result.mtimeMs, size: result.size })
      }
      const capability = previewKindOf(result.name)
      if (capability === 'office') {
        const officeView = await window.yan.office.preview(result.abs, cwd)
        if (!cancelled) {
          setViewSlot({ key: expectedViewKey, view: { kind: 'office', name: result.name, abs: result.abs, view: officeView } })
        }
        return
      }
      if (result.kind === 'image' && result.abs) {
        setViewSlot({ key: expectedViewKey, view: { kind: 'image', name: result.name, abs: result.abs } })
        return
      }
      if (result.kind === 'text' && typeof result.text === 'string') {
        setViewSlot({
          key: expectedViewKey,
          view: {
            kind: 'text',
            name: result.name,
            abs: result.abs,
            text: result.text,
            truncated: result.truncated === true,
            windowStart: result.windowStart,
            windowEnd: result.windowEnd
          }
        })
        return
      }
      setViewSlot({ key: expectedViewKey, view: { kind: 'binary', name: result.name, abs: result.abs, bytes: result.size } })
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [viewKey, activePath, owner.key, owner.cwd, text.failed])

  const view: PreviewView =
    viewKey && viewSlot && viewSlot.key === viewKey
      ? viewSlot.view
      : activePath
        ? { kind: 'loading', name: previewBaseName(activePath) }
        : { kind: 'empty' }
  const activeAbs = 'abs' in view ? view.abs : ''
  const name = 'name' in view ? view.name : ''

  const freshnessTarget =
    viewKey && diskStat && diskStat.key === viewKey
      ? { abs: diskStat.abs, cwd: owner.cwd, mtimeMs: diskStat.mtimeMs, size: diskStat.size }
      : null
  usePreviewFreshness(ownsCurrent, freshnessTarget, () => setReload((value) => value + 1))

  const openArtifact = useCallback(
    (artifactPath: string): void => {
      setSelections((prev) => recordPreviewSelection(prev, scopeKey, artifactPath, externalPath))
    },
    [scopeKey, externalPath]
  )

  const reveal = useCallback((): void => {
    if (activeAbs) void window.yan.revealPath(activeAbs)
  }, [activeAbs])
  const open = useCallback((): void => {
    if (activeAbs) void window.yan.openPath(activeAbs)
  }, [activeAbs])
  const copy = useCallback((): void => {
    if (activeAbs) void navigator.clipboard.writeText(activeAbs)
  }, [activeAbs])

  const crumbs = useMemo(() => {
    if (!activeAbs) return []
    const cwd = owner.cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    const abs = activeAbs.replace(/\\/g, '/')
    if (!cwd || !abs.startsWith(`${cwd}/`)) return []
    return abs.slice(cwd.length + 1).split('/').filter(Boolean)
  }, [activeAbs, owner.cwd])

  const selectTab = useCallback(
    (tab: string): void => {
      usePreviewBindings.getState().select(owner.key, tab)
    },
    [owner.key]
  )

  const closeTab = useCallback(
    (tab: string): void => {
      usePreviewBindings.getState().close(owner.key, tab)
    },
    [owner.key]
  )

  const closeAllTabs = useCallback((): void => {
    usePreviewBindings.getState().closeAll(owner.key)
  }, [owner.key])

  return (
    <section className="v3-preview" data-testid="v3-preview" aria-label={text.title}>
      {previewTabs && previewTabs.tabs.length > 1 ? (
        <div className="v3-preview-tabs" role="tablist" aria-label={text.tabsLabel} data-testid="v3-preview-tabs">
          <div className="v3-preview-tabstrip">
            {previewTabs.tabs.map((tab) => (
              <span
                key={tab}
                className={`v3-preview-tab${tab === previewTabs.active ? ' is-active' : ''}`}
                data-testid={`v3-preview-tab-${previewTabLabel(tab)}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === previewTabs.active}
                  className="v3-preview-tab-name"
                  title={tab}
                  onClick={() => selectTab(tab)}
                >
                  {previewTabLabel(tab)}
                </button>
                <button
                  type="button"
                  className="v3-preview-tab-close"
                  aria-label={`${text.closeTab}: ${previewTabLabel(tab)}`}
                  title={text.closeTab}
                  onClick={() => closeTab(tab)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <IconButton aria-label={text.closeAllTabs} title={text.closeAllTabs} onPress={closeAllTabs}>
            <X size={13} />
          </IconButton>
        </div>
      ) : null}
      <PaneHeader
        size="sm"
        title={<span title={activeAbs}>{name || text.title}</span>}
        actions={
          <>
            {activeAbs ? (
              <>
                <IconButton aria-label={text.open} title={text.open} onPress={open}>
                  <ExternalLink size={14} />
                </IconButton>
                <IconButton aria-label={text.reveal} title={text.reveal} onPress={reveal}>
                  <FolderOpen size={14} />
                </IconButton>
                <IconButton aria-label={text.copyPath} title={text.copyPath} onPress={copy}>
                  <Copy size={14} />
                </IconButton>
              </>
            ) : null}
            <IconButton aria-label={text.retry} title={text.retry} onPress={() => setReload((value) => value + 1)}>
              <RefreshCw size={14} />
            </IconButton>
          </>
        }
      />
      {crumbs.length > 1 ? (
        <nav className="v3-preview-crumbs" aria-label={text.crumbsLabel} data-testid="v3-preview-crumbs">
          {crumbs.map((segment, index) => {
            const isLast = index === crumbs.length - 1
            const dir = crumbs.slice(0, index + 1).join('/')
            return (
              <span key={dir} className="v3-preview-crumb-item">
                {index ? (
                  <span className="v3-preview-crumb-sep" aria-hidden>
                    /
                  </span>
                ) : null}
                {isLast ? (
                  <span className="v3-preview-crumb" title={segment}>
                    {segment}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="v3-preview-crumb"
                    title={dir}
                    onClick={() => void window.yan.revealPath(`${owner.cwd.replace(/[\\/]+$/, '')}/${dir}`)}
                  >
                    {segment}
                  </button>
                )}
              </span>
            )
          })}
        </nav>
      ) : null}
      <PreviewBody view={view} text={text} artifacts={artifacts} ownsCurrent={ownsCurrent} onOpenArtifact={openArtifact} />
    </section>
  )
}

function PreviewBody({
  view,
  text,
  artifacts,
  ownsCurrent,
  onOpenArtifact
}: {
  view: PreviewView
  text: PreviewText
  artifacts: AssistantArtifact[]
  ownsCurrent: boolean
  onOpenArtifact: (path: string) => void
}): ReactElement {
  switch (view.kind) {
    case 'empty':
      return ownsCurrent && artifacts.length ? (
        <EmptyState
          data-testid="v3-preview-empty"
          title={text.artifacts}
          description={text.emptyHint}
          action={
            <ul className="v3-preview-manifest" data-testid="v3-preview-manifest">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button type="button" className="v3-preview-manifest-item" onClick={() => onOpenArtifact(artifact.path)}>
                    <FileText size={13} aria-hidden />
                    <span className="v3-preview-manifest-name" title={artifact.path}>
                      {artifact.filename}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          }
        />
      ) : (
        <EmptyState
          data-testid="v3-preview-empty"
          icon={<FileText size={20} />}
          title={text.empty}
          description={ownsCurrent ? text.emptyHint : text.notOwner}
        />
      )
    case 'loading':
      return (
        <div className="v3-preview-loading" data-testid="v3-preview-loading" role="status">
          <Skeleton shape="text" />
          <Skeleton shape="text" width="70%" />
          <Skeleton shape="text" width="85%" />
          <span className="v3-preview-hint">{text.loading}</span>
        </div>
      )
    case 'error':
      return (
        <Notice tone="fail" className="v3-preview-error" data-testid="v3-preview-error">
          {view.message}
        </Notice>
      )
    case 'text':
      return <TextView view={view} text={text} />
    case 'image':
      return (
        <figure className="v3-preview-media" data-testid="v3-preview-image">
          <img src={filePreviewUrl(view.abs)} alt={view.name} draggable={false} />
          <figcaption className="v3-preview-hint">{text.imageNote}</figcaption>
        </figure>
      )
    case 'office':
      return <OfficeView view={view} text={text} />
    case 'binary':
      return (
        <EmptyState
          data-testid="v3-preview-binary"
          icon={<ImageIcon size={18} />}
          title={text.binary}
          description={
            <>
              {text.binaryHint}
              <br />
              {formatBytes(view.bytes)}
            </>
          }
        />
      )
  }
}

function TextView({
  view,
  text
}: {
  view: Extract<PreviewView, { kind: 'text' }>
  text: PreviewText
}): ReactElement {
  const lines = view.text.split('\n')
  const shown = lines.slice(0, MAX_RENDER_LINES)
  const rangeLabel =
    view.windowStart && view.windowEnd
      ? text.lineRange.replace('{start}', String(view.windowStart)).replace('{end}', String(view.windowEnd))
      : null
  return (
    <div className="v3-preview-text" data-testid="v3-preview-text">
      {rangeLabel ? <div className="v3-preview-note">{rangeLabel}</div> : null}
      <pre className="v3-preview-code">
        <code>{shown.join('\n')}</code>
      </pre>
      {lines.length > MAX_RENDER_LINES ? (
        <div className="v3-preview-note">{text.tooManyLines.replace('{n}', String(MAX_RENDER_LINES))}</div>
      ) : null}
      {view.truncated ? <div className="v3-preview-note">{text.truncated}</div> : null}
    </div>
  )
}

function OfficeView({
  view,
  text
}: {
  view: Extract<PreviewView, { kind: 'office' }>
  text: PreviewText
}): ReactElement {
  if (!view.view.ok) {
    return (
      <Notice tone="fail" className="v3-preview-error" data-testid="v3-preview-office-error">
        {view.view.error}
      </Notice>
    )
  }
  const total = view.view.sections.reduce((sum, section) => sum + section.lines.length, 0)
  const shouldTruncate = total > OFFICE_MAX_LINES
  return (
    <div className="v3-preview-office" data-testid="v3-preview-office">
      {view.view.sections.map((section, index) => (
        <section key={index} className="v3-preview-office-section">
          <h4 className="v3-preview-office-title">{section.title}</h4>
          <pre className="v3-preview-code">
            <code>{section.lines.join('\n')}</code>
          </pre>
        </section>
      ))}
      <div className="v3-preview-note">
        {view.view.note}
        {shouldTruncate ? ` ${text.truncated}` : ''}
      </div>
      <div className="v3-preview-hint">{text.officeNote}</div>
    </div>
  )
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
