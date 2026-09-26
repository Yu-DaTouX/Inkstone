import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { coursesForSpace, totalMinutes } from '../../../../shared/course'
import type { Course, CourseEntry, CourseLevel, CourseSourceRef, LearningUnit, UnitOrigin } from '../../../../shared/course'

/**
 * 课程与路线（实施-25 P07）。
 *
 * 这里是 P09「导师页面」三栏的**左栏先落地**：课程列表 + 路线（章节）。
 * 中间对话与右侧材料留给 P09；本片先把「从资料/主题/卡点生成路线、并调整它」做通。
 *
 * 三条必须显形的规则：
 *   · **材料 vs 补充**：每个单元都标出来。材料单元必须指回资料位置（点得开原文），
 *     补充单元必须写清为什么加 —— 界面上不允许出现「不知道哪来的」一节。
 *   · **不编页码**：定位只用字符区间（第 x–y 字），因为解析出的正文没有逐页边界。
 *   · **路线 ≠ 会话地图**：这里是一份独立的章节数据，不按会话分支渲染。
 */
interface Props {
  spaceId?: string | null
  /**
   * 「学这一节」的入口（P09）。
   *
   * 放在单元项上而不是另做一个课程下拉：位置只有一个事实源
   * （`StudySession`），入口多了就会成为第二份「我现在在学哪一节」。
   */
  onStudyUnit?: (courseId: string, unitId: string) => void
}

/** 来源预览只取开头一段（与成果页同一口径，避免把整本资料铺进列表）。 */
const PREVIEW_HEAD = 600
const PREVIEW_LEAD = 120

interface Preview {
  unitId: string
  ref: CourseSourceRef
  text: string
  error?: string
}

const ENTRIES: readonly CourseEntry[] = ['source', 'topic', 'stuck']
const LEVELS: readonly CourseLevel[] = ['new', 'some', 'confident']

export function LearningView({ spaceId, onStudyUnit }: Props): React.JSX.Element {
  const t = useT()
  const courses = useStore((s) => s.courses)
  const library = useStore((s) => s.library)
  const refresh = useStore((s) => s.refreshCourses)
  const createFromSource = useStore((s) => s.createCourseFromSource)
  const createFromTopic = useStore((s) => s.createCourseFromTopic)
  const createFromBlocker = useStore((s) => s.createCourseFromBlocker)
  const updateCourse = useStore((s) => s.updateCourse)
  const addUnit = useStore((s) => s.addCourseUnit)
  const updateUnit = useStore((s) => s.updateCourseUnit)
  const moveUnit = useStore((s) => s.moveCourseUnit)
  const removeUnit = useStore((s) => s.removeCourseUnit)
  const archiveCourse = useStore((s) => s.archiveCourse)
  const removeCourse = useStore((s) => s.removeCourse)
  const openRef = useStore((s) => s.openLibraryRef)

  const [selId, setSelId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [goalDraft, setGoalDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [unitDraft, setUnitDraft] = useState({ title: '', target: '', minutes: '30', note: '' })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [adding, setAdding] = useState(false)
  const [newUnit, setNewUnit] = useState({
    title: '',
    origin: 'model' as UnitOrigin,
    target: '',
    minutes: '30',
    note: '',
    sourceId: ''
  })
  const [form, setForm] = useState({
    title: '',
    goal: '',
    level: 'new' as CourseLevel,
    minutes: '30',
    entry: 'topic' as CourseEntry,
    entryInput: '',
    sourceId: ''
  })

  const listed = useMemo(
    () => coursesForSpace(courses, spaceId === undefined ? undefined : spaceId),
    [courses, spaceId]
  )
  const selected = listed.find((c) => c.id === selId) ?? null

  /*
   * 每次打开学习页都拉一次：宿主是事实源（agent / 另一个窗口可能在页面关着时
   * 改过路线）。矩阵不注册这个 IPC，注入的夹具不会被覆盖。
   */
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selId && listed[0]) {
      setSelId(listed[0].id)
      setTitleDraft(listed[0].title)
      setGoalDraft(listed[0].goal)
      setDirty(false)
      setEditingId(null)
      setPreview(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed[0]?.id])

  const pick = (course: Course): void => {
    if (course.id === selId) return
    setSelId(course.id)
    setTitleDraft(course.title)
    setGoalDraft(course.goal)
    setDirty(false)
    setEditingId(null)
    setPreview(null)
    setAdding(false)
  }

  const saveCourse = async (): Promise<void> => {
    if (!selected || !dirty) return
    const ok = await updateCourse(selected.id, { title: titleDraft.trim(), goal: goalDraft.trim() })
    if (ok) setDirty(false)
  }

  const create = async (): Promise<void> => {
    const title = form.title.trim()
    const goal = form.goal.trim()
    if (!title || !goal) return
    const base = {
      title,
      goal,
      level: form.level,
      minutesPerDay: Number(form.minutes) || 30,
      entry: form.entry,
      ...(spaceId ? { spaceId } : {}),
      ...(form.entryInput.trim() ? { entryInput: form.entryInput.trim() } : {})
    }
    const created =
      form.entry === 'source'
        ? form.sourceId
          ? await createFromSource({ sourceId: form.sourceId, version: sourceVersion(form.sourceId), input: base })
          : null
        : form.entry === 'stuck'
          ? await createFromBlocker({ ...base, goal: base.goal })
          : await createFromTopic(base)
    if (created) {
      setForm({ title: '', goal: '', level: 'new', minutes: '30', entry: form.entry, entryInput: '', sourceId: '' })
      setSelId(created.id)
      setTitleDraft(created.title)
      setGoalDraft(created.goal)
      setDirty(false)
    }
  }

  const submitUnit = async (): Promise<void> => {
    if (!selected) return
    const title = newUnit.title.trim()
    if (!title) return
    const minutes = Number(newUnit.minutes) || selected.minutesPerDay
    const ok =
      newUnit.origin === 'material'
        ? newUnit.sourceId
          ? await addUnit(selected.id, {
              title,
              origin: 'material',
              estimateMinutes: minutes,
              sources: [{ sourceId: newUnit.sourceId, version: sourceVersion(newUnit.sourceId) }],
              ...(newUnit.target.trim() ? { target: newUnit.target.trim() } : {})
            })
          : false
        : await addUnit(selected.id, {
            title,
            origin: 'model',
            estimateMinutes: minutes,
            note: newUnit.note.trim(),
            ...(newUnit.target.trim() ? { target: newUnit.target.trim() } : {})
          })
    if (ok) {
      setNewUnit({ title: '', origin: newUnit.origin, target: '', minutes: '30', note: '', sourceId: '' })
      setAdding(false)
    }
  }

  const startEdit = (unit: LearningUnit): void => {
    setEditingId(unit.id)
    setUnitDraft({
      title: unit.title,
      target: unit.target ?? '',
      minutes: String(unit.estimateMinutes),
      note: unit.note ?? ''
    })
  }

  const submitEdit = async (): Promise<void> => {
    if (!selected || !editingId) return
    const ok = await updateUnit(selected.id, editingId, {
      title: unitDraft.title.trim(),
      target: unitDraft.target.trim() || null,
      estimateMinutes: Number(unitDraft.minutes) || 30,
      ...(unitDraft.note.trim() ? { note: unitDraft.note.trim() } : {})
    })
    if (ok) setEditingId(null)
  }

  const openSource = async (unitId: string, ref: CourseSourceRef): Promise<void> => {
    const view = await openRef({ sourceId: ref.sourceId, version: ref.version }, 20000)
    const text = view && view.ok ? (view.text ?? '') : ''
    if (!text) {
      setPreview({ unitId, ref, text: '', error: view?.error ?? t('space.learn.previewNone') })
      return
    }
    setPreview({ unitId, ref, text })
  }

  /** 来源在资料库里的当前版本号（建单元时用最新版；生成路线时用当时那一版）。 */
  function sourceVersion(sourceId: string): number {
    const versions = useStore.getState().libraryVersions.filter((v) => v.sourceId === sourceId)
    return versions.length ? Math.max(...versions.map((v) => v.version)) : 1
  }

  function sourceTitle(sourceId: string): string {
    return library.find((s) => s.id === sourceId)?.title ?? sourceId
  }

  /** 基础水平的展示文案（动态 key 过不了 `MessageKey` 联合类型，所以显式映射）。 */
  function levelLabel(level: CourseLevel): string {
    return level === 'new'
      ? t('space.learn.level.new')
      : level === 'some'
        ? t('space.learn.level.some')
        : t('space.learn.level.confident')
  }

  /** 入口的展示文案。 */
  function entryLabel(entry: CourseEntry): string {
    return entry === 'source'
      ? t('space.learn.entrySource')
      : entry === 'stuck'
        ? t('space.learn.entryStuck')
        : t('space.learn.entryTopic')
  }

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
        note: t('space.learn.located', { start: locator.start, end: locator.end })
      }
    }
    const cut = preview.text.length > PREVIEW_HEAD
    return {
      before: preview.text.slice(0, PREVIEW_HEAD),
      hit: '',
      after: '',
      ...(cut ? { note: t('space.learn.previewCut') } : {})
    }
  })()

  return (
    <div className="wb-learn" data-testid="space-learn-panel">
      <div className="wb-learn-list" data-testid="space-learn-list">
        <div className="wb-art-list-head">
          <span>{t('space.learn.count', { n: listed.length })}</span>
        </div>

        <div className="wb-learn-new">
          <input
            data-testid="space-learn-new-title"
            value={form.title}
            placeholder={t('space.learn.newTitle')}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            data-testid="space-learn-new-goal"
            value={form.goal}
            placeholder={t('space.learn.newGoal')}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
          />
          <div className="wb-learn-new-row">
            <select
              data-testid="space-learn-new-entry"
              value={form.entry}
              aria-label={t('space.learn.newEntry')}
              onChange={(e) => setForm({ ...form, entry: e.target.value as CourseEntry })}
            >
              {ENTRIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry === 'source'
                    ? t('space.learn.entrySource')
                    : entry === 'topic'
                      ? t('space.learn.entryTopic')
                      : t('space.learn.entryStuck')}
                </option>
              ))}
            </select>
            <select
              data-testid="space-learn-new-level"
              value={form.level}
              aria-label={t('space.learn.level')}
              onChange={(e) => setForm({ ...form, level: e.target.value as CourseLevel })}
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {levelLabel(level)}
                </option>
              ))}
            </select>
            <input
              className="wb-learn-minutes"
              data-testid="space-learn-new-minutes"
              value={form.minutes}
              inputMode="numeric"
              aria-label={t('space.learn.minutesPerDay')}
              onChange={(e) => setForm({ ...form, minutes: e.target.value })}
            />
          </div>
          {form.entry === 'source' ? (
            library.length === 0 ? (
              <p className="wb-card-meta" data-testid="space-learn-no-source">
                {t('space.learn.newSourceNone')}
              </p>
            ) : (
              <select
                data-testid="space-learn-new-source"
                value={form.sourceId}
                aria-label={t('space.learn.newSource')}
                onChange={(e) => setForm({ ...form, sourceId: e.target.value })}
              >
                <option value="">{t('space.learn.newSource')}</option>
                {library.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.title}
                  </option>
                ))}
              </select>
            )
          ) : null}
          {form.entry !== 'source' ? (
            <input
              data-testid="space-learn-new-input"
              value={form.entryInput}
              placeholder={form.entry === 'stuck' ? t('space.learn.blockerPlaceholder') : t('space.learn.topicPlaceholder')}
              onChange={(e) => setForm({ ...form, entryInput: e.target.value })}
            />
          ) : null}
          <button
            data-testid="space-learn-create"
            disabled={!form.title.trim() || !form.goal.trim() || (form.entry === 'source' && !form.sourceId)}
            onClick={() => void create()}
          >
            {t('space.learn.create')}
          </button>
        </div>

        {listed.length === 0 ? (
          <p className="wb-card-empty" data-testid="space-learn-empty">
            {t('space.learn.empty')}
          </p>
        ) : (
          <ul className="wb-list">
            {listed.map((course) => (
              <li key={course.id}>
                <button
                  className={`wb-list-item ${selId === course.id ? 'on' : ''}`}
                  data-testid={`space-learn-item-${course.id}`}
                  onClick={() => pick(course)}
                >
                  <Icon name="layers" size={12} />
                  <span className="wb-list-title">{course.title}</span>
                  <span className="wb-list-meta">
                    {t('space.learn.units', { n: course.units.length })} · {t('space.learn.entryTag', {
                      entry: entryLabel(course.entry)
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wb-learn-route" data-testid="space-learn-route">
        {!selected ? (
          <p className="wb-card-empty" data-testid="space-learn-placeholder">
            {t('space.learn.select')}
          </p>
        ) : (
          <>
            <header className="wb-art-head">
              <input
                className="wb-art-title"
                data-testid="space-learn-title"
                value={titleDraft}
                aria-label={t('space.learn.titleAria')}
                onChange={(e) => {
                  setTitleDraft(e.target.value)
                  setDirty(true)
                }}
              />
              <div className="wb-art-actions">
                <button data-testid="space-learn-save" disabled={!dirty} onClick={() => void saveCourse()}>
                  <Icon name="check" size={12} />
                  {t('space.learn.save')}
                </button>
                <button
                  data-testid="space-learn-archive"
                  onClick={() => void archiveCourse(selected.id, true)}
                >
                  {t('space.learn.archive')}
                </button>
                <button
                  data-testid="space-learn-delete"
                  onClick={() => {
                    if (!window.confirm(t('space.learn.deleteConfirm'))) return
                    void (async () => {
                      if (await removeCourse(selected.id)) setSelId(null)
                    })()
                  }}
                >
                  {t('space.learn.delete')}
                </button>
              </div>
            </header>

            <div className="wb-learn-fields">
              <input
                className="wb-learn-goal"
                data-testid="space-learn-goal"
                value={goalDraft}
                placeholder={t('space.learn.newGoal')}
                aria-label={t('space.learn.goal')}
                onChange={(e) => {
                  setGoalDraft(e.target.value)
                  setDirty(true)
                }}
              />
              <div className="wb-learn-meta" data-testid="space-learn-meta">
                <span>{t('space.learn.units', { n: selected.units.length })}</span>
                <span>{t('space.learn.totalMinutes', { n: totalMinutes(selected) })}</span>
                <span>{levelLabel(selected.level)}</span>
                <span>{t('space.learn.minutesPerDayValue', { n: selected.minutesPerDay })}</span>
              </div>
              {selected.basedOn ? (
                <div className="wb-learn-basis" data-testid="space-learn-basis">
                  <button
                    data-testid="space-learn-basis-open"
                    onClick={() => void openSource('basis', selected.basedOn as CourseSourceRef)}
                  >
                    <Icon name="globe" size={12} />
                    {t('space.learn.basedOn', { title: sourceTitle(selected.basedOn.sourceId) })}
                  </button>
                  {selected.truncated ? (
                    <span className="wb-card-meta" data-testid="space-learn-truncated">
                      {t('space.learn.truncated')}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {selected.units.length === 0 ? (
              <p className="wb-card-empty" data-testid="space-learn-units-empty">
                {t('space.learn.unitsEmpty')}
              </p>
            ) : (
              <ol className="wb-learn-units" data-testid="space-learn-units">
                {selected.units.map((unit, index) => (
                  <li
                    key={unit.id}
                    className={`wb-learn-unit ${unit.origin}`}
                    data-testid={`space-learn-unit-${unit.id}`}
                  >
                    <div className="wb-learn-unit-head">
                      <span className="wb-learn-index">{index + 1}</span>
                      {editingId === unit.id ? (
                        <input
                          className="wb-learn-unit-title"
                          data-testid={`space-learn-unit-title-${unit.id}`}
                          value={unitDraft.title}
                          onChange={(e) => setUnitDraft({ ...unitDraft, title: e.target.value })}
                        />
                      ) : (
                        <span className="wb-learn-unit-title" data-testid={`space-learn-unit-name-${unit.id}`}>
                          {unit.title}
                        </span>
                      )}
                      <span
                        className={`wb-learn-origin ${unit.origin}`}
                        data-testid={`space-learn-unit-origin-${unit.id}`}
                      >
                        {unit.origin === 'material' ? t('space.learn.originMaterial') : t('space.learn.originModel')}
                      </span>
                      <span className="wb-learn-unit-minutes">{t('space.learn.unitMinutes', { n: unit.estimateMinutes })}</span>
                      <div className="wb-learn-unit-actions">
                        {onStudyUnit ? (
                          <button
                            className="wb-learn-unit-study"
                            data-testid={`space-learn-unit-study-${unit.id}`}
                            title={t('space.tutor.studyThis')}
                            onClick={() => onStudyUnit(selected.id, unit.id)}
                          >
                            {t('space.tutor.studyThis')}
                          </button>
                        ) : null}
                        <button
                          data-testid={`space-learn-unit-up-${unit.id}`}
                          disabled={index === 0}
                          title={t('space.learn.up')}
                          onClick={() => void moveUnit(selected.id, unit.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          data-testid={`space-learn-unit-down-${unit.id}`}
                          disabled={index === selected.units.length - 1}
                          title={t('space.learn.down')}
                          onClick={() => void moveUnit(selected.id, unit.id, 1)}
                        >
                          ↓
                        </button>
                        {editingId === unit.id ? (
                          <>
                            <button data-testid={`space-learn-unit-save-${unit.id}`} onClick={() => void submitEdit()}>
                              {t('space.learn.saveEdit')}
                            </button>
                            <button
                              data-testid={`space-learn-unit-cancel-${unit.id}`}
                              onClick={() => setEditingId(null)}
                            >
                              {t('space.learn.cancelEdit')}
                            </button>
                          </>
                        ) : (
                          <button
                            data-testid={`space-learn-unit-edit-${unit.id}`}
                            onClick={() => startEdit(unit)}
                          >
                            {t('space.learn.edit')}
                          </button>
                        )}
                        <button
                          data-testid={`space-learn-unit-remove-${unit.id}`}
                          title={t('space.learn.remove')}
                          onClick={() => void removeUnit(selected.id, unit.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {editingId === unit.id ? (
                      <div className="wb-learn-unit-edit">
                        <input
                          data-testid={`space-learn-unit-target-${unit.id}`}
                          value={unitDraft.target}
                          placeholder={t('space.learn.unitTargetPlaceholder')}
                          onChange={(e) => setUnitDraft({ ...unitDraft, target: e.target.value })}
                        />
                        <input
                          className="wb-learn-minutes"
                          data-testid={`space-learn-unit-minutes-${unit.id}`}
                          value={unitDraft.minutes}
                          inputMode="numeric"
                          aria-label={t('space.learn.unitMinutesAria')}
                          onChange={(e) => setUnitDraft({ ...unitDraft, minutes: e.target.value })}
                        />
                        {unit.origin === 'model' ? (
                          <input
                            data-testid={`space-learn-unit-note-${unit.id}`}
                            value={unitDraft.note}
                            placeholder={t('space.learn.addNote')}
                            onChange={(e) => setUnitDraft({ ...unitDraft, note: e.target.value })}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {unit.target ? (
                          <p className="wb-learn-target" data-testid={`space-learn-unit-target-text-${unit.id}`}>
                            {unit.target}
                          </p>
                        ) : null}
                        {unit.origin === 'model' && unit.note ? (
                          <p className="wb-card-meta" data-testid={`space-learn-unit-note-text-${unit.id}`}>
                            {unit.note}
                          </p>
                        ) : null}
                      </>
                    )}

                    {unit.sources.length > 0 ? (
                      <div className="wb-learn-sources">
                        {unit.sources.map((ref, refIndex) => (
                          <button
                            key={`${ref.sourceId}@${ref.version}`}
                            className={`wb-learn-source ${preview?.unitId === unit.id ? 'on' : ''}`}
                            data-testid={`space-learn-unit-source-${unit.id}-${refIndex}`}
                            title={t('space.learn.openSource')}
                            onClick={() => void openSource(unit.id, ref)}
                          >
                            <Icon name="globe" size={12} />
                            {sourceTitle(ref.sourceId)} · v{ref.version}
                            {ref.locator
                              ? ` · ${t('space.learn.located', { start: ref.locator.start, end: ref.locator.end })}`
                              : ''}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}

            {preview ? (
              <div className="wb-learn-preview" data-testid="space-learn-preview">
                <div className="wb-art-source-preview-head">
                  <span className="wb-list-meta">
                    {sourceTitle(preview.ref.sourceId)} · v{preview.ref.version}
                  </span>
                  <button data-testid="space-learn-preview-close" onClick={() => setPreview(null)}>
                    {t('space.learn.previewClose')}
                  </button>
                </div>
                {preview.error ? (
                  <p className="wb-card-empty" data-testid="space-learn-preview-error">
                    {preview.error}
                  </p>
                ) : (
                  <p className="wb-art-source-text" data-testid="space-learn-preview-text">
                    {previewBody.before}
                    {previewBody.hit ? <mark>{previewBody.hit}</mark> : null}
                    {previewBody.after}
                  </p>
                )}
                {previewBody.note ? (
                  <p className="wb-card-meta" data-testid="space-learn-preview-note">
                    {previewBody.note}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="wb-learn-add">
              {adding ? (
                <>
                  <div className="wb-learn-new-row">
                    <input
                      data-testid="space-learn-add-title"
                      value={newUnit.title}
                      placeholder={t('space.learn.addTitle')}
                      onChange={(e) => setNewUnit({ ...newUnit, title: e.target.value })}
                    />
                    <select
                      data-testid="space-learn-add-origin"
                      value={newUnit.origin}
                      aria-label={t('space.learn.addOrigin')}
                      onChange={(e) => setNewUnit({ ...newUnit, origin: e.target.value as UnitOrigin })}
                    >
                      <option value="model">{t('space.learn.originModel')}</option>
                      <option value="material">{t('space.learn.originMaterial')}</option>
                    </select>
                    <input
                      className="wb-learn-minutes"
                      data-testid="space-learn-add-minutes"
                      value={newUnit.minutes}
                      inputMode="numeric"
                      aria-label={t('space.learn.unitMinutesAria')}
                      onChange={(e) => setNewUnit({ ...newUnit, minutes: e.target.value })}
                    />
                  </div>
                  {newUnit.origin === 'model' ? (
                    <input
                      data-testid="space-learn-add-note"
                      value={newUnit.note}
                      placeholder={t('space.learn.addNote')}
                      onChange={(e) => setNewUnit({ ...newUnit, note: e.target.value })}
                    />
                  ) : library.length === 0 ? (
                    <p className="wb-card-meta" data-testid="space-learn-add-nosource">
                      {t('space.learn.newSourceNone')}
                    </p>
                  ) : (
                    <select
                      data-testid="space-learn-add-source"
                      value={newUnit.sourceId}
                      aria-label={t('space.learn.addSource')}
                      onChange={(e) => setNewUnit({ ...newUnit, sourceId: e.target.value })}
                    >
                      <option value="">{t('space.learn.addSource')}</option>
                      {library.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.title}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    data-testid="space-learn-add-target"
                    value={newUnit.target}
                    placeholder={t('space.learn.unitTargetPlaceholder')}
                    onChange={(e) => setNewUnit({ ...newUnit, target: e.target.value })}
                  />
                  <div className="wb-learn-new-row">
                    <button
                      data-testid="space-learn-add-submit"
                      disabled={
                        !newUnit.title.trim() ||
                        (newUnit.origin === 'material' && !newUnit.sourceId) ||
                        (newUnit.origin === 'model' && !newUnit.note.trim())
                      }
                      onClick={() => void submitUnit()}
                    >
                      {t('space.learn.addSubmit')}
                    </button>
                    <button data-testid="space-learn-add-cancel" onClick={() => setAdding(false)}>
                      {t('space.learn.cancelEdit')}
                    </button>
                  </div>
                </>
              ) : (
                <button data-testid="space-learn-add" onClick={() => setAdding(true)}>
                  {t('space.learn.addUnit')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
