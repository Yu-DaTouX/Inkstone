import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { BookOpen, Code2, Copy, FileText, Folder, FolderOpen, Image as ImageIcon, ExternalLink, ListTree, Pencil, RefreshCw, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, EmptyState, IconButton, Notice, PaneHeader, Skeleton } from '../../ui'
import { OFFICE_MAX_LINES, type OfficeDocumentView } from '../../../../shared/office'
import type { AssistantArtifact, FilePreview } from '../../../../shared/ipc'
import { filePreviewUrl } from '../../lib/file-preview-url'
import { ownerOwnsSession, ownerScopedRead, previewKindOf } from '../artifacts/model'
import { CodeEditor } from '../editor/CodeEditor'
import { Markdown } from '../session/Markdown'
import { PaneTitle, usePaneChrome, usePaneMenu, type PaneMenuItem } from '../workbench/pane-chrome'
import { editorIsEditableKind } from '../editor/editor-language'
import { usePreviewBindings, usePreviewTabs } from '../workbench/tool-tiles'
import type { PreviewPaneProps } from '../workbench/types'
import { previewText, type PreviewText } from './preview-text'
import { usePreviewFreshness } from './use-preview-freshness'
import { CodeView, type CodeViewTarget, type CodeViewText } from './CodeView'
import { PreviewTabs } from './PreviewTabs'
import { useFileViewSettings } from './use-file-view-settings'
import { FILE_TAB_SIZES, type FileViewSettings } from './file-view-settings'
import { previewBodyKind, previewNotes, previewProblem, type PreviewNote, type PreviewProblem } from './preview-issue'
import { reportUnsavedEditor } from '../editor/unsaved-registry'
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

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

function isMarkdownName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

function parentDir(abs: string): string {
  const at = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
  return at > 0 ? abs.slice(0, at) : abs
}

interface PreviewDraft {
  abs: string
  text: string
  original: string
  hash: string
  saving: boolean
  conflict: boolean
  failed: boolean
}

type PreviewView =
  | { kind: 'empty' }
  | { kind: 'loading'; name: string }
  | { kind: 'text'; name: string; abs: string; text: string; truncated: boolean; windowStart?: number; windowEnd?: number; notes: PreviewNote[] }
  | { kind: 'image'; name: string; abs: string; notes: PreviewNote[] }
  | { kind: 'office'; name: string; abs: string; view: OfficeDocumentView }
  | { kind: 'binary'; name: string; abs: string; bytes: number; media: boolean; notes: PreviewNote[] }
  | { kind: 'problem'; name: string; problem: PreviewProblem }
  | { kind: 'error'; name: string; message: string }

export function PreviewPane({ owner, path, treeShown = true, onRevealInTree }: PreviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = previewText(lang)
  const [viewSlot, setViewSlot] = useState<{ key: string; view: PreviewView } | null>(null)
  const [diskStat, setDiskStat] = useState<{ key: string; abs: string; mtimeMs?: number; size?: number } | null>(null)
  const [reload, setReload] = useState(0)
  const [selections, setSelections] = useState<ReadonlyMap<string, PreviewSelectionEntry>>(() => new Map())
  const previewTabs = usePreviewTabs(owner.key)
  const [draft, setDraft] = useState<PreviewDraft | null>(null)
  const [sourceChoice, setSourceChoice] = useState<boolean | null>(null)
  const [viewSettings, setViewSetting] = useFileViewSettings()
  const chrome = usePaneChrome()

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
      const problem = previewProblem(result)
      if (problem) {
        setViewSlot({ key: expectedViewKey, view: { kind: 'problem', name: result.name || name, problem } })
        return
      }
      const notes = previewNotes(result)
      const body = previewBodyKind(result)
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
      if (body === 'image' && result.abs) {
        setViewSlot({ key: expectedViewKey, view: { kind: 'image', name: result.name, abs: result.abs, notes } })
        return
      }
      if (body === 'text' && typeof result.text === 'string') {
        setViewSlot({
          key: expectedViewKey,
          view: {
            kind: 'text',
            name: result.name,
            abs: result.abs,
            text: result.text,
            truncated: result.truncated === true,
            windowStart: result.windowStart,
            windowEnd: result.windowEnd,
            notes
          }
        })
        return
      }
      setViewSlot({ key: expectedViewKey, view: { kind: 'binary', name: result.name, abs: result.abs, bytes: result.size, media: body === 'media', notes } })
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
  const editing = !!draft && !!activeAbs && draft.abs === activeAbs
  const editable = view.kind === 'text' && editorIsEditableKind(name)
  const dirty = !!draft && draft.text !== draft.original
  const editorId = useId()
  const unsavedPath = dirty && draft ? draft.abs : null
  useEffect(() => {
    reportUnsavedEditor(editorId, unsavedPath)
  }, [editorId, unsavedPath])
  useEffect(() => () => reportUnsavedEditor(editorId, null), [editorId])
  const markdown = view.kind === 'text' && isMarkdownName(name)
  const tabTarget = previewTabs?.target
  const codeTarget: CodeViewTarget | null =
    tabTarget && activePath && samePath(tabTarget.path, activePath) ? { line: tabTarget.line, lineEnd: tabTarget.lineEnd, nonce: tabTarget.nonce } : null
  const sourceMode = sourceChoice ?? !!codeTarget
  const reading = markdown && !sourceMode && !editing

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

  const beginEdit = useCallback(async (): Promise<void> => {
    if (!activeAbs) return
    if (activePath) usePreviewBindings.getState().keep(owner.key, activePath)
    const result = await window.yan.readEditableFile(activeAbs, owner.cwd)
    if (!result.ok) {
      setDraft({ abs: activeAbs, text: '', original: '', hash: '', saving: false, conflict: false, failed: true })
      return
    }
    setDraft({ abs: activeAbs, text: result.text, original: result.text, hash: result.hash, saving: false, conflict: false, failed: false })
  }, [activeAbs, activePath, owner.key, owner.cwd])

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!draft) return
    const current = draft
    setDraft((prev) => (prev ? { ...prev, saving: true } : prev))
    const result = await window.yan.writeEditableFile(current.abs, current.text, current.hash, owner.cwd)
    setDraft((prev) => {
      if (!prev || prev.abs !== current.abs) return prev
      if (result.status === 'saved') {
        return { ...prev, original: current.text, hash: result.hash ?? prev.hash, saving: false, conflict: false, failed: false }
      }
      return { ...prev, saving: false, conflict: result.status === 'conflict', failed: result.status !== 'conflict' }
    })
    if (result.status === 'saved') setReload((value) => value + 1)
  }, [draft, owner.cwd])

  const reloadDraft = useCallback(async (): Promise<void> => {
    if (!draft) return
    const result = await window.yan.readEditableFile(draft.abs, owner.cwd)
    if (!result.ok) {
      setDraft((prev) => (prev ? { ...prev, conflict: false, failed: true } : prev))
      return
    }
    setDraft({ abs: draft.abs, text: result.text, original: result.text, hash: result.hash, saving: false, conflict: false, failed: false })
  }, [draft, owner.cwd])

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

  const tabList = previewTabs && previewTabs.tabs.length > 0 ? previewTabs.tabs : activePath ? [activePath] : []
  const activeTab = previewTabs?.active ?? activePath ?? ''
  const bindings = usePreviewBindings.getState
  const tabStrip = tabList.length ? (
    <PreviewTabs
      tabs={tabList}
      active={activeTab}
      preview={previewTabs?.preview ?? null}
      cwd={owner.cwd}
      chrome={!!chrome}
      text={text}
      onSelect={selectTab}
      onClose={closeTab}
      onKeep={(tab) => bindings().keep(owner.key, tab)}
      onCloseOthers={(tab) => bindings().closeOthers(owner.key, tab)}
      onCloseRight={(tab) => bindings().closeRight(owner.key, tab)}
      onCloseAll={closeAllTabs}
      onRevealInTree={onRevealInTree}
    />
  ) : null

  const toolButtons = (
    <>
      {markdown && !editing ? (
        <IconButton
          size="sm"
          aria-label={sourceMode ? text.readingMode : text.sourceMode}
          title={sourceMode ? text.readingMode : text.sourceMode}
          data-testid="v3-preview-reading-toggle"
          onPress={() => setSourceChoice(!sourceMode)}
        >
          {sourceMode ? <BookOpen size={14} /> : <Code2 size={14} />}
        </IconButton>
      ) : null}
      {editable ? (
        <IconButton
          size="sm"
          aria-label={editing ? text.viewMode : text.edit}
          title={editing ? text.viewMode : text.edit}
          aria-pressed={editing}
          data-testid="v3-preview-edit-toggle"
          onPress={() => {
            if (editing) setDraft(null)
            else void beginEdit()
          }}
        >
          {editing ? <FileText size={14} /> : <Pencil size={14} />}
        </IconButton>
      ) : null}
    </>
  )

  usePaneMenu(
    'preview',
    activeAbs
      ? [
          { id: 'preview:open', label: text.open, icon: <ExternalLink size={14} aria-hidden />, onAction: open },
          { id: 'preview:reveal', label: text.reveal, icon: <FolderOpen size={14} aria-hidden />, onAction: reveal },
          { id: 'preview:copy', label: text.copyPath, icon: <Copy size={14} aria-hidden />, onAction: copy },
          ...(onRevealInTree && crumbs.length
            ? [{ id: 'preview:revealInTree', label: text.revealInTree, icon: <ListTree size={14} aria-hidden />, onAction: () => onRevealInTree(activeAbs) }]
            : []),
          { id: 'preview:reload', label: text.retry, icon: <RefreshCw size={14} aria-hidden />, onAction: () => setReload((value) => value + 1) },
          ...(tabList.length > 1 ? [{ id: 'preview:closeAll', label: text.closeAllTabs, icon: <X size={14} aria-hidden />, onAction: closeAllTabs }] : [])
        ]
      : []
  )

  usePaneMenu('preview-view', activeAbs ? viewSettingsMenu(viewSettings, setViewSetting, text) : [])

  const crumbNav = crumbs.length > 1 ? (
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
  ) : null
  const pathRow = chrome && activeAbs ? (
    <div className="v3-preview-pathbar" data-testid="v3-preview-pathbar">
      {crumbNav ?? (
        <span className="v3-preview-pathname" title={activeAbs}>
          {name}
        </span>
      )}
      <span className="v3-preview-pathtools">{toolButtons}</span>
    </div>
  ) : crumbNav

  return (
    <section className="v3-preview" data-testid="v3-preview" aria-label={text.title}>
      {chrome ? (
        <>
          <PaneTitle>{tabStrip}</PaneTitle>
        </>
      ) : (
        <>
          {previewTabs && previewTabs.tabs.length > 1 ? (
            <div className="v3-preview-tabs">
              {tabStrip}
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
                    {toolButtons}
                  </>
                ) : null}
                <IconButton aria-label={text.retry} title={text.retry} onPress={() => setReload((value) => value + 1)}>
                  <RefreshCw size={14} />
                </IconButton>
              </>
            }
          />
        </>
      )}
      {editing && draft ? (
        <div className="v3-preview-editbar" data-testid="v3-preview-editbar">
          <span className="v3-preview-editstate">
            {draft.saving
              ? text.saving
              : draft.conflict
                ? text.conflict
                : draft.failed
                  ? text.saveFailed
                  : dirty
                    ? text.dirty
                    : text.saved}
          </span>
          {draft.conflict ? (
            <Button size="sm" variant="ghost" onPress={() => void reloadDraft()}>
              {text.reload}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" isDisabled={draft.saving || !dirty} onPress={() => void saveDraft()}>
            {text.save}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setDraft(null)}>
            {dirty ? text.discard : text.closeEditor}
          </Button>
        </div>
      ) : null}

      {pathRow}
      {editing && draft ? (
        <CodeEditor
          value={draft.text}
          name={name}
          settings={viewSettings}
          onChange={(value) =>
            setDraft((prev) => (prev && prev.abs === draft.abs ? { ...prev, text: value, failed: false } : prev))
          }
          onSave={() => void saveDraft()}
        />
      ) : (
        <PreviewBody
          view={view}
          text={text}
          artifacts={artifacts}
          ownsCurrent={ownsCurrent}
          reading={reading}
          settings={viewSettings}
          target={codeTarget}
          hasTabs={tabList.length > 0}
          treeShown={treeShown}
          onOpenArtifact={openArtifact}
        />
      )}
    </section>
  )
}

function PreviewBody({
  view,
  text,
  artifacts,
  ownsCurrent,
  reading,
  settings,
  target,
  hasTabs,
  treeShown,
  onOpenArtifact
}: {
  view: PreviewView
  text: PreviewText
  artifacts: AssistantArtifact[]
  ownsCurrent: boolean
  reading: boolean
  settings: FileViewSettings
  target: CodeViewTarget | null
  hasTabs: boolean
  treeShown: boolean
  onOpenArtifact: (path: string) => void
}): ReactElement {
  const emptyTitle = hasTabs ? text.noSelection : text.emptyTitle
  const emptyHint = hasTabs ? text.noSelectionHint : treeShown ? text.emptyTree : text.emptyNoTree
  switch (view.kind) {
    case 'empty':
      return ownsCurrent && artifacts.length ? (
        <EmptyState
          data-testid="v3-preview-empty"
          icon={<Folder size={20} />}
          title={emptyTitle}
          description={emptyHint}
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
          icon={<Folder size={20} />}
          title={emptyTitle}
          description={ownsCurrent ? emptyHint : text.notOwner}
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
    case 'problem':
      return <ProblemView problem={view.problem} text={text} />
    case 'text':
      return (
        <>
          <PreviewNotes notes={view.notes.filter((note) => note !== 'too_large')} text={text} />
          {reading ? <MarkdownView view={view} text={text} /> : <TextView view={view} text={text} settings={settings} target={target} />}
        </>
      )
    case 'image':
      return (
        <>
          <PreviewNotes notes={view.notes} text={text} />
          <figure className="v3-preview-media" data-testid="v3-preview-image">
            <img src={filePreviewUrl(view.abs)} alt={view.name} draggable={false} />
          </figure>
        </>
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
              {view.media ? text.mediaHint : text.binaryHint}
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
  text,
  settings,
  target
}: {
  view: Extract<PreviewView, { kind: 'text' }>
  text: PreviewText
  settings: FileViewSettings
  target: CodeViewTarget | null
}): ReactElement {
  const labels = useMemo<CodeViewText>(
    () => ({ label: text.codeLabel, plainNote: text.plainNote, fold: text.fold, unfold: text.unfold, folded: text.folded }),
    [text]
  )
  return (
    <div className="v3-preview-text v3-preview-text--code" data-testid="v3-preview-text">
      <CodeView key={view.abs} text={view.text} name={view.name} settings={settings} firstNumber={view.windowStart ?? 1} target={target} labels={labels} />
      {view.truncated ? <div className="v3-preview-note">{text.truncated}</div> : null}
    </div>
  )
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

function viewSettingsMenu(
  settings: FileViewSettings,
  set: <K extends keyof FileViewSettings>(key: K, value: FileViewSettings[K]) => void,
  text: PreviewText
): PaneMenuItem[] {
  const toggle = (key: 'wordWrap' | 'indentGuides' | 'showWhitespace' | 'scrollPastEnd' | 'previewTabs', label: string): PaneMenuItem => ({
    id: `preview-view:${key}`,
    label,
    checked: settings[key],
    onAction: () => {
      set(key, !settings[key])
      if (key === 'previewTabs' && settings.previewTabs) usePreviewBindings.getState().keepAll()
    }
  })
  return [
    toggle('wordWrap', text.wordWrap),
    toggle('indentGuides', text.indentGuides),
    toggle('showWhitespace', text.showWhitespace),
    toggle('scrollPastEnd', text.scrollPastEnd),
    ...FILE_TAB_SIZES.map((size) => ({
      id: `preview-view:tab${size}`,
      label: text.tabSize.replace('{n}', String(size)),
      checked: settings.tabSize === size,
      onAction: () => set('tabSize', size)
    })),
    toggle('previewTabs', text.previewTabs)
  ]
}

function PreviewNotes({ notes, text }: { notes: PreviewNote[]; text: PreviewText }): ReactElement | null {
  if (!notes.length) return null
  return (
    <div className="v3-preview-notes" data-testid="v3-preview-notes">
      {notes.map((note) => (
        <Notice key={note} tone={note === 'encoding' ? 'stall' : 'info'} className="v3-preview-banner">
          {note === 'outside' ? text.outsideRoot : note === 'encoding' ? text.encodingNote : text.truncated}
        </Notice>
      ))}
    </div>
  )
}

function ProblemView({ problem, text }: { problem: PreviewProblem; text: PreviewText }): ReactElement {
  const title =
    problem.kind === 'missing'
      ? text.missing
      : problem.kind === 'directory'
        ? text.directory
        : problem.kind === 'unreadable'
          ? text.unreadable
          : problem.kind === 'invalid'
            ? text.invalidPath
            : problem.kind === 'not_file'
              ? text.notFile
              : text.failed
  const description =
    problem.kind === 'missing' ? (problem.creatable ? text.missingCreatable : text.missingHint) : problem.kind === 'failed' ? problem.message : undefined
  return (
    <EmptyState
      data-testid={'v3-preview-problem-' + problem.kind}
      icon={<FileText size={20} />}
      title={title}
      description={description}
    />
  )
}

function MarkdownView({
  view,
  text
}: {
  view: Extract<PreviewView, { kind: 'text' }>
  text: PreviewText
}): ReactElement {
  return (
    <div className="v3-preview-text v3-preview-reading" data-testid="v3-preview-markdown">
      <div className="v3-preview-md">
        <Markdown text={view.text} sourceCwd={parentDir(view.abs)} />
      </div>
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
