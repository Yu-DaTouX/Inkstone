/**
 * v3 预览面板（P3 · R5）：查看具体文件的只读预览。
 *
 * 能力边界（与工作区契约、设计规范一致）：
 *   · 文本 / 源码：`yan:readPreview`（主进程 realpath 校验、只读、大小上限、越界拒绝）；
 *   · 图片：同样先经 `readPreview` 校验，命中后才用**主进程返回的** `abs` 只读地址；
 *     绝不对模型输出或原始 `path` 直接拼 `file://`；
 *   · Office（docx/xlsx/pptx/pdf）：`yan:office:preview` 由宿主提取正文；
 *   · 二进制：只显示元信息，不假装能预览；
 *   · 成果 HTML 走消息里的 `ArtifactFrame`（`inkstone-html` 协议），这里不另开协议、不放宽 CSP。
 *
 * 归属：选择与已加载视图都按 `previewScopeKey(owner)`（会话键 + cwd）绑定，在 render
 * 计算 `activePath` 之前就隔离——新 owner 的首帧不会拿旧 owner 的文件去请求，也不会
 * 显示旧内容；读取返回后再用 `ownerScopedRead` 核一次 owner，迟到响应不写进当前界面。
 * 规则与淘汰见 `preview-selection.ts`。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Copy, FileText, FolderOpen, Image as ImageIcon, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton, Skeleton } from '../../ui'
import { OFFICE_MAX_LINES, type OfficeDocumentView } from '../../../../shared/office'
import type { AssistantArtifact, FilePreview } from '../../../../shared/ipc'
import { filePreviewUrl } from '../../lib/file-preview-url'
import { ownerOwnsSession, ownerScopedRead, previewKindOf } from '../artifacts/model'
import type { PreviewPaneProps } from '../workbench/types'
import { previewText, type PreviewText } from './preview-text'
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

/** 一次渲染的最大行数；更大的文件只显示窗口，不铺满 DOM。 */
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
  /* 已加载的视图跟它所属的请求键一起存；key 不匹配当前请求就不显示，不靠先渲染再清。 */
  const [viewSlot, setViewSlot] = useState<{ key: string; view: PreviewView } | null>(null)
  const [reload, setReload] = useState(0)
  /* 面板内点选按 owner 作用域绑定（不是单个 string）。 */
  const [selections, setSelections] = useState<ReadonlyMap<string, PreviewSelectionEntry>>(() => new Map())

  /*
   * 归属隔离发生在 render 里：先用当前 owner 的作用域取选择和外部 path，
   * 得到 `activePath` 之后才做任何异步读取。切到没有绑定的 owner 就是 `undefined`，
   * 首帧不会拿旧 owner 的路径去请求。外部 path 在同一个 owner 内换值就接管。
   */
  const scopeKey = previewScopeKey(owner)
  const externalPath = path ?? null
  const resolved = resolvePreviewPath(selections.get(scopeKey), externalPath)
  if (resolved.externalChanged) {
    setSelections((prev) => dropPreviewSelection(prev, scopeKey))
  }
  const activePath = resolved.path
  const viewKey = previewViewKey(scopeKey, activePath, reload)
  /* 最新 owner 键：异步读取返回后用它核对归属，切走就丢弃旧结果。 */
  const ownerKeyRef = useRef(owner.key)
  ownerKeyRef.current = owner.key

  /* 成果 manifest 的渲染端投影：会话消息里已由主进程 hydrate；只有 owner
     真的拥有当前 store 会话时才列，绝不把另一条会话的成果拿来冒充。 */
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

  /* 只有属于当前请求键的已加载视图才显示；其余一律按「加载中 / 空」重新取。 */
  const view: PreviewView =
    viewKey && viewSlot && viewSlot.key === viewKey
      ? viewSlot.view
      : activePath
        ? { kind: 'loading', name: previewBaseName(activePath) }
        : { kind: 'empty' }
  const activeAbs = 'abs' in view ? view.abs : ''
  const name = 'name' in view ? view.name : ''

  /* 面板内点选：绑给当前 owner 作用域，并记下当刻的外部 path。 */
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

  return (
    <section className="v3-preview" data-testid="v3-preview" aria-label={text.title}>
      <div className="v3-preview-bar">
        <span className="v3-preview-name" title={activeAbs}>
          {name || text.title}
        </span>
        <div className="v3-preview-actions">
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
        </div>
      </div>
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
      return (
        <div className="v3-preview-empty" data-testid="v3-preview-empty">
          {ownsCurrent && artifacts.length ? (
            <>
              <p>{text.artifacts}</p>
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
              <p className="v3-preview-hint">{text.emptyHint}</p>
            </>
          ) : (
            <>
              <FileText size={20} aria-hidden />
              <p>{text.empty}</p>
              <p className="v3-preview-hint">{ownsCurrent ? text.emptyHint : text.notOwner}</p>
            </>
          )}
        </div>
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
        <div className="v3-preview-error" data-testid="v3-preview-error" role="alert">
          <TriangleAlert size={16} aria-hidden />
          <span>{view.message}</span>
        </div>
      )
    case 'text':
      return <TextView view={view} text={text} />
    case 'image':
      return (
        <figure className="v3-preview-media" data-testid="v3-preview-image">
          {/* 只用主进程 `readPreview` 校验后返回的 `abs`（realpath、普通文件、大小上限）。 */}
          <img src={filePreviewUrl(view.abs)} alt={view.name} draggable={false} />
          <figcaption className="v3-preview-hint">{text.imageNote}</figcaption>
        </figure>
      )
    case 'office':
      return <OfficeView view={view} text={text} />
    case 'binary':
      return (
        <div className="v3-preview-binary" data-testid="v3-preview-binary">
          <ImageIcon size={18} aria-hidden />
          <p>{text.binary}</p>
          <p className="v3-preview-hint">{text.binaryHint}</p>
          <p className="v3-preview-hint">{formatBytes(view.bytes)}</p>
        </div>
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
      <div className="v3-preview-error" data-testid="v3-preview-office-error" role="alert">
        <TriangleAlert size={16} aria-hidden />
        <span>{view.view.error}</span>
      </div>
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
