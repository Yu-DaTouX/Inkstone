import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import {
  currentTextOf,
  currentVersionOf,
  parseChecklist,
  splitParagraphs
} from '../../../../shared/artifact-doc'
import type { ArtifactDoc, ArtifactKind, ArtifactSourceRef, ArtifactVersion } from '../../../../shared/artifact-doc'
import { sourceChangeSummary } from '../../../../shared/research'

/**
 * 成果视图（实施-25 P06a / P06b）。
 *
 * 数据来自 `ArtifactDocStore`（宿主）：正文与版本都由主进程算好，界面只负责
 * 显示与提交。**这里不做版本推进** —— 「用户编辑不被 agent 覆盖」这条不变量
 * 在 `shared/artifact-doc.ts` 的纯函数里，界面自己实现一套就一定会跑偏。
 *
 * 编辑语义：
 *   · 保存（用户编辑）走 `saveArtifactText` → 内容没变就不开新版本；
 *   · 历史版本只读浏览，「回到当前版本」才回到可编辑状态；
 *   · 切换成果时若有未保存改动，先保存再切（不静默丢草稿）。
 *
 * P06b 在这里补三件事：
 *   · **结构化清单**（`kind: 'checklist'`）：正文是 Markdown 任务列表，勾选走
 *     `toggleChecklist` —— 勾选算用户编辑（开新版本、进保护集），不是界面私改；
 *   · **引用回原文**：点来源就按 `{sourceId, version}` 打开那一版正文，带 locator
 *     时标出引用区间 —— 打开的是**当时引用的那一版**，不是资料最新版；
 *   · **导出 Markdown**：宿主弹保存框，界面只显示落盘路径。
 *
 * T06b-4「用于学习」也在这里：宿主把当前正文登记成一份资料库来源、再按
 * 「学这份资料」生成路线。界面**不自己做转化**，只传成果 id 与目标。
 */
interface Props {
  spaceId?: string | null
}

/** 来源预览：无 locator 时只给开头一段，避免把整本资料铺进编辑器。 */
const PREVIEW_HEAD = 600
const PREVIEW_LEAD = 120

interface SourcePreview {
  ref: ArtifactSourceRef
  text: string
  truncated: boolean
  error?: string
}

export function ArtifactView({ spaceId }: Props): React.JSX.Element {
  const t = useT()
  const docs = useStore((s) => s.artifactDocs)
  const library = useStore((s) => s.library)
  const refresh = useStore((s) => s.refreshArtifactDocs)
  const create = useStore((s) => s.createArtifactDoc)
  const save = useStore((s) => s.saveArtifactText)
  const rename = useStore((s) => s.renameArtifactDoc)
  const remove = useStore((s) => s.removeArtifactDoc)
  const toggleItem = useStore((s) => s.toggleArtifactChecklistItem)
  const exportDoc = useStore((s) => s.exportArtifactDoc)
  const turnIntoCourse = useStore((s) => s.createCourseFromArtifact)
  const sourceStatuses = useStore((s) => s.artifactSourceStatuses)
  const comparison = useStore((s) => s.researchComparison)
  const refreshSourceStatus = useStore((s) => s.refreshArtifactSourceStatus)
  const runComparison = useStore((s) => s.runComparison)
  const clearComparison = useStore((s) => s.clearComparison)
  const openSpaceView = useStore((s) => s.openSpaceView)
  const openRef = useStore((s) => s.openLibraryRef)

  const [selId, setSelId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftText, setDraftText] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newKind, setNewKind] = useState<ArtifactKind>('markdown')
  const [viewing, setViewing] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [exported, setExported] = useState('')
  const [learnOpen, setLearnOpen] = useState(false)
  const [learnGoal, setLearnGoal] = useState('')
  const [learnBusy, setLearnBusy] = useState(false)
  const [preview, setPreview] = useState<SourcePreview | null>(null)

  const listed = useMemo(() => docs, [docs])
  const selected = listed.find((d) => d.id === selId) ?? null

  /*
   * 每次打开成果页都向宿主拉一次。
   * 为什么不做「拉过就不再拉」的缓存守卫：agent / 另一个窗口可以在成果页关着的
   * 时候改掉成果（版本也会变），拿缓存就会显示旧版。**宿主是事实源**。
   * （视觉矩阵不注册这个 IPC，所以注入的夹具不会被覆盖。）
   */
  useEffect(() => {
    void refresh(spaceId === undefined ? undefined : spaceId)
  }, [refresh, spaceId])

  /** 把某份成果的当前版本装进编辑器（历史浏览态清空）。 */
  const load = (doc: ArtifactDoc): void => {
    setSelId(doc.id)
    setDraftTitle(doc.title)
    setDraftText(currentTextOf(doc))
    setViewing(null)
    setDirty(false)
    setExported('')
    setPreview(null)
  }

  const firstId = listed[0]?.id
  useEffect(() => {
    if (!selId && firstId) {
      const doc = listed.find((d) => d.id === firstId)
      if (doc) load(doc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId])

  /*
   * 宿主那边已经改过正文（勾选清单 / 保存成功）时，把草稿同步回来。
   * **只在没有未保存改动时同步** —— 否则会把用户正在敲的字冲掉。
   */
  useEffect(() => {
    if (selected && !dirty && viewing === null) setDraftText(currentTextOf(selected))
  }, [selected, dirty, viewing])

  /** 保存草稿；`silent` 用于「切换成果前顺手保存」，不弹提示。 */
  const saveDraft = async (_silent = false): Promise<void> => {
    if (!selected || viewing !== null) return
    const titleChanged = draftTitle.trim() && draftTitle.trim() !== selected.title
    if (titleChanged) await rename(selected.id, draftTitle.trim())
    if (dirty) {
      const res = await save(selected.id, draftText)
      if (res.ok) setDirty(false)
    }
  }

  const pick = async (doc: ArtifactDoc): Promise<void> => {
    if (doc.id === selId) return
    if (dirty) await saveDraft(true)
    load(doc)
  }

  const createNew = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    const doc = await create({ title, kind: newKind, ...(spaceId ? { spaceId } : {}) })
    if (doc) {
      setNewTitle('')
      await refresh(spaceId === undefined ? undefined : spaceId)
      load(doc)
    }
  }

  /** 点来源 → 打开**引用时的那一版**（不是资料最新版）。 */
  const openSource = async (ref: ArtifactSourceRef): Promise<void> => {
    const view = await openRef({ sourceId: ref.sourceId, version: ref.version }, 20000)
    if (!view || !view.ok) {
      setPreview({ ref, text: '', truncated: false, error: view?.error ?? t('space.art.sourceMissing') })
      return
    }
    const text = view.text ?? ''
    setPreview({
      ref,
      text,
      truncated: view.truncated === true,
      ...(text ? {} : { error: t('space.art.noSourceText') })
    })
  }

  const current = selected ? currentVersionOf(selected) : undefined
  const selectedId = selected?.id ?? null
  /* 换成果就把上一份的引用状态与对照清掉 —— 它们都是「这份成果的」。 */
  useEffect(() => {
    clearComparison()
    if (selectedId) void refreshSourceStatus(selectedId)
  }, [selectedId, refreshSourceStatus, clearComparison])
  const changeNote = sourceChangeSummary(sourceStatuses)
  const viewingVersion: ArtifactVersion | undefined =
    selected && viewing !== null ? selected.versions.find((v) => v.version === viewing) : undefined
  const userEdited = viewingVersion ?? current
  const userEditedCount = userEdited ? userEdited.userEditedParagraphs.length : 0
  const checklist = selected && selected.kind === 'checklist' ? parseChecklist(draftText) : []

  /** 来源预览的三种显示：定位区间 / 开头一段 / 读不到。 */
  const previewBody = ((): { before: string; hit: string; after: string; note?: string } => {
    if (!preview || preview.error) return { before: '', hit: '', after: '' }
    const locator = preview.ref.locator
    if (locator) {
      const start = Math.max(0, Math.min(locator.start, preview.text.length))
      const end = Math.max(start, Math.min(locator.end, preview.text.length))
      return {
        before: preview.text.slice(Math.max(0, start - PREVIEW_LEAD), start),
        hit: preview.text.slice(start, end),
        after: preview.text.slice(end, Math.min(preview.text.length, end + PREVIEW_LEAD)),
        note: t('space.art.sourceLocated', { start: locator.start, end: locator.end })
      }
    }
    const cut = preview.text.length > PREVIEW_HEAD
    return {
      before: preview.text.slice(0, PREVIEW_HEAD),
      hit: '',
      after: '',
      ...(cut || preview.truncated ? { note: t('space.art.sourceTruncated') } : {})
    }
  })()

  /** 导出：先把未保存的改动落盘（否则导出的是旧正文），再弹保存框。 */
  /**
   * 「用于学习」（T06b-4）：把这份成果交给宿主转成课程。
   *
   * 先保存草稿再转 —— 否则用户刚写的那段不会进材料（转完就跳走了）。
   */
  const toLearnFlow = async (): Promise<void> => {
    if (!selected) return
    const goal = learnGoal.trim()
    if (!goal) return
    setLearnBusy(true)
    try {
      if (dirty) await saveDraft(true)
      const course = await turnIntoCourse({
        artifactId: selected.id,
        input: {
          title: selected.title,
          goal,
          entry: 'source',
          ...(spaceId ? { spaceId } : {})
        }
      })
      if (!course) return
      setLearnOpen(false)
      setLearnGoal('')
      openSpaceView('learning')
    } finally {
      setLearnBusy(false)
    }
  }

  /**
   * 多来源对照（T13-2）：把当前成果引用的资料并排。
   *
   * 立场标签不由界面猜 —— 这里只把来源列出来（未标注立场），
   * 真正带立场的对照由模型经 `yan research compare` 提交。
   * **不合并结论**这条规则在宿主的纯函数里，界面不做第二套。
   */
  const compareFlow = async (): Promise<void> => {
    if (!selected) return
    await runComparison({
      question: selected.title,
      refs: selected.sources.map((ref) => ({
        sourceId: ref.sourceId,
        version: ref.version,
        ...(ref.locator ? { locator: ref.locator } : {})
      })),
      maxChars: 400
    })
  }

  const exportFlow = async (): Promise<void> => {
    if (!selected) return
    if (dirty) await saveDraft()
    const res = await exportDoc(selected.id)
    if (res.ok && res.path) setExported(res.path)
  }

  return (
    <div className="wb-art" data-testid="space-artifact">
      <div className="wb-art-list" data-testid="space-art-list">
        <div className="wb-art-list-head">
          <span>{t('space.art.count', { n: listed.length })}</span>
        </div>
        <div className="wb-art-new">
          <input
            data-testid="space-art-new-title"
            value={newTitle}
            placeholder={t('space.art.newPlaceholder')}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createNew()
            }}
          />
          <select
            className="wb-art-new-kind"
            data-testid="space-art-new-kind"
            value={newKind}
            aria-label={t('space.art.newKind')}
            onChange={(e) => setNewKind(e.target.value as ArtifactKind)}
          >
            <option value="markdown">{t('space.art.kindMarkdown')}</option>
            <option value="checklist">{t('space.art.kindChecklist')}</option>
          </select>
          <button data-testid="space-art-create" disabled={!newTitle.trim()} onClick={() => void createNew()}>
            {t('space.art.create')}
          </button>
        </div>
        {listed.length === 0 ? (
          <p className="wb-card-empty" data-testid="space-art-empty">
            {t('space.art.empty')}
          </p>
        ) : (
          <ul className="wb-list">
            {listed.map((doc) => (
              <li key={doc.id}>
                <button
                  className={`wb-list-item ${selId === doc.id ? 'on' : ''}`}
                  data-testid={`space-art-item-${doc.id}`}
                  onClick={() => void pick(doc)}
                >
                  <Icon name="tag" size={12} />
                  <span className="wb-list-title">{doc.title}</span>
                  <span className="wb-list-meta">
                    {doc.kind === 'checklist' ? `${t('space.art.kindChecklist')} · ` : ''}
                    {t('space.art.versions', { n: doc.versions.length })} · {t('space.art.sources', { n: doc.sources.length })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wb-art-editor" data-testid="space-art-editor">
        {!selected ? (
          <p className="wb-card-empty" data-testid="space-art-placeholder">
            {t('space.art.select')}
          </p>
        ) : (
          <>
            <header className="wb-art-head">
              <input
                className="wb-art-title"
                data-testid="space-art-title"
                value={draftTitle}
                placeholder={t('space.art.titlePlaceholder')}
                onChange={(e) => {
                  setDraftTitle(e.target.value)
                  setDirty(true)
                }}
              />
              <div className="wb-art-actions">
                <button data-testid="space-art-tolearn" onClick={() => setLearnOpen((v) => !v)}>
                  <Icon name="layers" size={12} />
                  {t('space.art.toLearn')}
                </button>
                <button data-testid="space-art-export" onClick={() => void exportFlow()}>
                  <Icon name="folder" size={12} />
                  {t('space.art.export')}
                </button>
                <button
                  data-testid="space-art-save"
                  disabled={viewing !== null || !dirty}
                  onClick={() => void saveDraft()}
                >
                  <Icon name="check" size={12} />
                  {t('space.art.save')}
                </button>
                <button
                  data-testid="space-art-delete"
                  onClick={() => {
                    if (!window.confirm(t('space.art.deleteConfirm'))) return
                    void (async () => {
                      if (await remove(selected.id)) setSelId(null)
                    })()
                  }}
                >
                  {t('space.art.delete')}
                </button>
              </div>
            </header>

            {learnOpen ? (
              <div className="wb-art-tolearn" data-testid="space-art-tolearn-panel">
                <p className="wb-card-meta" data-testid="space-art-tolearn-hint">
                  {t('space.art.toLearnHint')}
                </p>
                <div className="wb-art-tolearn-row">
                  <input
                    className="wb-art-tolearn-input"
                    data-testid="space-art-tolearn-goal"
                    value={learnGoal}
                    placeholder={t('space.art.toLearnGoal')}
                    onChange={(e) => setLearnGoal(e.target.value)}
                  />
                  <button
                    data-testid="space-art-tolearn-go"
                    disabled={!learnGoal.trim() || learnBusy}
                    onClick={() => void toLearnFlow()}
                  >
                    {learnBusy ? t('space.art.toLearnBusy') : t('space.art.toLearnGo')}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="wb-art-meta">
              <span data-testid="space-art-kind">
                {selected.kind === 'checklist' ? t('space.art.kindChecklist') : t('space.art.kindMarkdown')}
              </span>
              <span data-testid="space-art-current">
                {t('space.art.current', { n: selected.currentVersion })} · {t('space.art.versions', { n: selected.versions.length })}
              </span>
              {userEditedCount > 0 ? (
                <span data-testid="space-art-useredited">{t('space.art.userEdited', { n: userEditedCount })}</span>
              ) : null}
              {dirty ? <span data-testid="space-art-dirty">{t('space.art.dirty')}</span> : null}
              {exported ? (
                <span className="wb-art-exported" data-testid="space-art-exported">
                  {t('space.art.exported', { path: exported })}
                </span>
              ) : null}
            </div>

            <div className="wb-art-versions" data-testid="space-art-versions">
              {[...selected.versions].reverse().map((v) => (
                <button
                  key={v.version}
                  className={`wb-art-version ${viewing === v.version ? 'on' : ''}`}
                  data-testid={`space-art-version-${v.version}`}
                  onClick={() => {
                    setViewing(v.version)
                    setDraftText(v.text)
                    setDirty(false)
                  }}
                >
                  v{v.version} · {v.editedBy === 'user' ? t('space.art.versionUser') : t('space.art.versionAgent')}
                </button>
              ))}
              {viewing !== null ? (
                <button
                  className="wb-art-back"
                  data-testid="space-art-back"
                  onClick={() => {
                    if (!selected) return
                    setViewing(null)
                    setDraftText(currentTextOf(selected))
                    setDirty(false)
                  }}
                >
                  {t('space.art.backToCurrent')}
                </button>
              ) : null}
            </div>

            {viewing !== null ? (
              <p className="wb-card-meta" data-testid="space-art-history-note">
                {t('space.art.viewingHistory', { n: viewing })}
              </p>
            ) : null}

            {selected.kind === 'checklist' && viewing === null ? (
              <div className="wb-art-checklist" data-testid="space-art-checklist">
                {checklist.length === 0 ? (
                  <p className="wb-card-meta" data-testid="space-art-checklist-empty">
                    {t('space.art.checklistEmpty')}
                  </p>
                ) : (
                  checklist.map((item, index) => (
                    <label key={`${item.line}-${index}`} className={`wb-art-check ${item.done ? 'done' : ''}`}>
                      <input
                        type="checkbox"
                        data-testid={`space-art-check-${index}`}
                        checked={item.done}
                        onChange={() => void toggleItem(selected.id, index)}
                      />
                      <span>{item.text}</span>
                    </label>
                  ))
                )}
              </div>
            ) : null}

            <textarea
              className="wb-art-body"
              data-testid="space-art-body"
              value={draftText}
              readOnly={viewing !== null}
              placeholder={selected.kind === 'checklist' ? t('space.art.checklistPlaceholder') : t('space.art.bodyPlaceholder')}
              onChange={(e) => {
                setDraftText(e.target.value)
                setDirty(true)
              }}
            />

            {selected.sources.length > 0 ? (
              <div className="wb-art-sources" data-testid="space-art-sources">
                <div className="wb-art-sources-top">
                  <span className="wb-art-sources-head">{t('space.art.sourcesTitle')}</span>
                  <button
                    className="wb-art-source-compare"
                    data-testid="space-art-compare"
                    title={t('space.art.compareHint')}
                    onClick={() => void compareFlow()}
                  >
                    <Icon name="layers" size={12} />
                    {t('space.art.compare')}
                  </button>
                </div>
                {/* T13-4：来源变化只提示，不改引用 —— 旧版本仍是旧版本。 */}
                {changeNote ? (
                  <p className="wb-card-meta wb-art-source-changed" data-testid="space-art-source-changed">
                    {changeNote}
                  </p>
                ) : null}
                <ul className="wb-art-source-list">
                  {selected.sources.map((ref, index) => {
                    const hit = library.find((s) => s.id === ref.sourceId)
                    const status = sourceStatuses[index]
                    return (
                      <li key={`${ref.sourceId}@${ref.version}`}>
                        <button
                          className={`wb-art-source ${preview?.ref.sourceId === ref.sourceId && preview.ref.version === ref.version ? 'on' : ''}`}
                          data-testid={`space-art-source-${index}`}
                          title={t('space.art.sourceOpen')}
                          onClick={() => void openSource(ref)}
                        >
                          <Icon name="globe" size={12} />
                          <span className="wb-art-source-title">{hit?.title ?? ref.sourceId}</span>
                          <span className="wb-list-meta">
                            v{ref.version}
                            {ref.locator ? ` · ${t('space.art.sourceLocated', { start: ref.locator.start, end: ref.locator.end })}` : ''}
                          </span>
                        </button>
                        {status && status.status !== 'current' ? (
                          <span
                            className={`wb-art-source-status ${status.status}`}
                            data-testid={`space-art-source-status-${index}`}
                          >
                            {status.note}
                          </span>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}

            {/* 多来源对照（T13-2）：并排保留不一致，不合并成一个结论。 */}
            {comparison ? (
              <div className="wb-art-compare" data-testid="space-art-compare-view">
                <p className="wb-card-meta" data-testid="space-art-compare-note">
                  {t('space.art.compareNote', {
                    material: comparison.provenance.material,
                    model: comparison.provenance.model
                  })}
                </p>
                {comparison.groups.map((group, gi) => (
                  <div key={group.label} className="wb-art-compare-group" data-testid={`space-art-compare-group-${gi}`}>
                    <span className="wb-art-compare-label" data-testid={`space-art-compare-label-${gi}`}>
                      {group.label}
                    </span>
                    {group.excerpts.map((excerpt) => (
                      <div key={`${excerpt.sourceId}@${excerpt.version}`} className="wb-art-compare-row">
                        <span className={`wb-art-prov ${excerpt.provenance}`}>
                          {excerpt.provenance === 'model' ? t('space.art.provModel') : t('space.art.provMaterial')}
                        </span>
                        <span className="wb-art-compare-title">
                          {excerpt.title} v{excerpt.version}
                        </span>
                        <p className="wb-art-compare-text">{excerpt.text}</p>
                      </div>
                    ))}
                  </div>
                ))}
                {comparison.conflicts.length > 0 ? (
                  <ul className="wb-art-compare-conflicts" data-testid="space-art-compare-conflicts">
                    {comparison.conflicts.map((conflict, ci) => (
                      <li key={conflict.label} data-testid={`space-art-compare-conflict-${ci}`}>
                        {conflict.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="wb-card-meta">{comparison.note}</p>
              </div>
            ) : null}

            {preview ? (
              <div className="wb-art-source-preview" data-testid="space-art-source-preview">
                <div className="wb-art-source-preview-head">
                  <span className="wb-list-meta">
                    {library.find((s) => s.id === preview.ref.sourceId)?.title ?? preview.ref.sourceId} · v
                    {preview.ref.version}
                  </span>
                  <button data-testid="space-art-source-close" onClick={() => setPreview(null)}>
                    {t('space.art.sourceClose')}
                  </button>
                </div>
                {preview.error ? (
                  <p className="wb-card-empty" data-testid="space-art-source-error">
                    {preview.error}
                  </p>
                ) : (
                  <p className="wb-art-source-text" data-testid="space-art-source-text">
                    {previewBody.before}
                    {previewBody.hit ? <mark>{previewBody.hit}</mark> : null}
                    {previewBody.after}
                  </p>
                )}
                {previewBody.note ? (
                  <p className="wb-card-meta" data-testid="space-art-source-note">
                    {previewBody.note}
                  </p>
                ) : null}
              </div>
            ) : null}

            <footer className="wb-art-foot">
              <span className="wb-card-meta">
                {selected.kind === 'checklist'
                  ? t('space.art.items', { n: checklist.length })
                  : t('space.art.paragraphs', { n: splitParagraphs(draftText).length })}
              </span>
              {current ? (
                <span className="wb-card-meta">
                  {current.editedBy === 'user' ? t('space.art.versionUser') : t('space.art.versionAgent')} ·{' '}
                  {new Date(current.at).toLocaleString()}
                </span>
              ) : null}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
