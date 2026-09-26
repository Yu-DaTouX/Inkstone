import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { Space } from '../../../../shared/space'
import type { LibraryOpenView } from '../../../../shared/ipc'

/**
 * 资料视图（实施-25 P04 / T04-4）。
 *
 * 数据全部来自 P03 的 `library`（唯一事实源）：**这一层不做第二次过滤**，
 * 「已移除 / 原件不可用 / 仅附件」这些结论都由主进程的 `refOutcome` 给出，
 * 界面只负责翻译成文案。理由很直接 —— 同一个状态如果在两处判定，
 * 迟早会出现「列表里还在、点进去说已移除」。
 *
 * 预览也只按 `{ sourceId, version }` 打开（P03 的 T03-2），所以旧版本永远
 * 开得到旧内容；「加入对话」登记的是**会话引用**（P03 的引用模型），
 * 正文注入上下文由 P05 的 ContextAssembler 接。
 */
interface Props {
  space?: Space
  spaceId?: string
}

export function LibraryView({ space, spaceId }: Props): React.JSX.Element {
  const t = useT()
  const session = useStore((s) => s.session)
  const library = useStore((s) => s.library)
  const versions = useStore((s) => s.libraryVersions)
  const refs = useStore((s) => s.libraryRefs)
  const loaded = useStore((s) => s.libraryLoaded)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const openLibraryRef = useStore((s) => s.openLibraryRef)
  const attachLibrarySource = useStore((s) => s.attachLibrarySource)
  const removeLibrarySource = useStore((s) => s.removeLibrarySource)
  const restoreLibrarySource = useStore((s) => s.restoreLibrarySource)
  const joinLibraryRef = useStore((s) => s.joinLibraryRef)

  const [selId, setSelId] = useState<string | null>(null)
  const [preview, setPreview] = useState<LibraryOpenView | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [joined, setJoined] = useState<Record<string, boolean>>({})

  const listed = useMemo(
    () => (spaceId ? library.filter((s) => s.spaceId === spaceId) : library),
    [library, spaceId]
  )
  const latestOf = (id: string): { version: number } | undefined =>
    versions.filter((v) => v.sourceId === id).sort((a, b) => b.version - a.version)[0]
  const refCount = (id: string): number => refs.filter((r) => r.ref.sourceId === id).length
  const selected = listed.find((s) => s.id === selId) ?? null

  useEffect(() => {
    if (!loaded) void refreshLibrary()
  }, [loaded, refreshLibrary])

  /** 打开预览：**只按 id + version**（旧版本照样开得到旧内容） */
  const open = async (id: string): Promise<void> => {
    setSelId(id)
    const v = latestOf(id)
    if (!v) {
      setPreview(null)
      return
    }
    setPreviewLoading(true)
    const res = await openLibraryRef({ sourceId: id, version: v.version }, 4000)
    setPreview(res)
    setPreviewLoading(false)
  }

  const firstId = listed[0]?.id
  useEffect(() => {
    if (!selId && firstId) void open(firstId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId])

  const outcomeLabel = (o: LibraryOpenView['outcome']): string =>
    t(
      (
        {
          ok: 'space.outcome.ok',
          removed: 'space.outcome.removed',
          unavailable: 'space.outcome.unavailable',
          unsupported: 'space.outcome.unsupported',
          pending: 'space.outcome.pending',
          failed: 'space.outcome.failed',
          missing: 'space.outcome.missing'
        } as const
      )[o]
    )

  const kindIcon = (kind: string): 'image' | 'folder' | 'globe' =>
    kind === 'image' ? 'image' : kind === 'file' ? 'folder' : 'globe'

  const join = async (id: string): Promise<void> => {
    const v = latestOf(id)
    if (!v) return
    if (await joinLibraryRef({ sourceId: id, version: v.version })) {
      setJoined((p) => ({ ...p, [id]: true }))
    }
  }

  return (
    <div className="wb-lib" data-testid="space-library">
      <div className="wb-lib-list" data-testid="space-lib-list">
        <div className="wb-lib-list-head">
          <span>{t('space.lib.count', { n: listed.length })}</span>
        </div>
        {listed.length === 0 ? (
          <p className="wb-card-empty" data-testid="space-lib-empty">
            {t('space.lib.empty')}
          </p>
        ) : (
          <ul className="wb-list">
            {listed.map((s) => (
              <li key={s.id}>
                <button
                  className={`wb-list-item ${selId === s.id ? 'on' : ''}`}
                  data-testid={`space-lib-item-${s.id}`}
                  onClick={() => void open(s.id)}
                >
                  <Icon name={kindIcon(s.kind)} size={12} />
                  <span className="wb-list-title">{s.title}</span>
                  <span className="wb-list-meta">
                    {t('space.lib.versions', { n: versions.filter((v) => v.sourceId === s.id).length })} ·{' '}
                    {t('space.lib.refs', { n: refCount(s.id) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wb-lib-preview" data-testid="space-lib-preview">
        {!selected ? (
          <p className="wb-card-empty">{t('space.lib.preview')}</p>
        ) : (
          <>
            <header className="wb-lib-preview-head">
              <span className="wb-list-title" data-testid="space-lib-preview-title">
                {selected.title}
              </span>
              {preview ? (
                <span
                  className={`wb-lib-badge ${preview.outcome === 'ok' ? 'ok' : 'warn'}`}
                  data-testid="space-lib-outcome"
                >
                  {outcomeLabel(preview.outcome)}
                </span>
              ) : null}
            </header>

            <div className="wb-lib-actions">
              <button
                data-testid="space-lib-join"
                disabled={!session?.sessionId}
                title={session?.sessionId ? '' : t('space.lib.noSession')}
                onClick={() => void join(selected.id)}
              >
                <Icon name="send" size={12} />
                {joined[selected.id] ? t('space.lib.joined') : t('space.lib.join')}
              </button>
              {spaceId ? (
                selected.spaceId === spaceId ? (
                  <button data-testid="space-lib-detach" onClick={() => void attachLibrarySource(selected.id, null)}>
                    {t('space.lib.detach')}
                  </button>
                ) : (
                  <button data-testid="space-lib-attach" onClick={() => void attachLibrarySource(selected.id, spaceId)}>
                    {t('space.lib.attach')}
                  </button>
                )
              ) : null}
              {selected.removedAt ? (
                <button data-testid="space-lib-restore" onClick={() => void restoreLibrarySource(selected.id)}>
                  {t('space.lib.restore')}
                </button>
              ) : (
                <button data-testid="space-lib-remove" onClick={() => void removeLibrarySource(selected.id)}>
                  {t('space.lib.remove')}
                </button>
              )}
            </div>

            <div className="wb-lib-text" data-testid="space-lib-text">
              {previewLoading ? (
                <p className="wb-card-empty">{t('space.lib.previewLoading')}</p>
              ) : !preview ? (
                <p className="wb-card-empty">{t('space.lib.errLoad')}</p>
              ) : preview.text ? (
                <pre className="wb-lib-pre">{preview.text}</pre>
              ) : (
                <p className="wb-card-empty">{t('space.lib.previewEmpty')}</p>
              )}
              {preview?.truncated ? <p className="wb-card-meta">…</p> : null}
            </div>

            <footer className="wb-lib-foot">
              <span className="wb-card-meta">
                {selected.spaceId ? (space?.name ?? t('space.unknown')) : t('space.unfiled')}
              </span>
              {preview?.version ? <span className="wb-card-meta">v{preview.version.version}</span> : null}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
