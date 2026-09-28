import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { OBSERVATION_LABELS } from '../../../../shared/learning-memory'
import type { Concept } from '../../../../shared/course'
import type { LearningNote, NoteKind } from '../../../../shared/learning-memory'

/**
 * 概念进度与笔记（实施-25 P11）—— 挂在内核页左栏的路线下方。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是 R7 的两条轴
 * ══════════════════════════════════════════════════════════
 *   · **观察层级**与**复习状态**是两条轴，界面必须**同时**显示，
 *     不能合成一个「状态」标签 —— 「曾独立完成 + 建议复习」是正常情况，不是冲突。
 *   · **用户自评与系统观察并存**：自评按钮只写 `selfAssessment`，
 *     不改 `level` / `review`；两者在界面上分别摆出来，谁也不覆盖谁。
 *
 * 界面**不提供**「手动改观察层级」的入口：那一层由宿主持作答现算（T11-3），
 * 手改会让「进度」退化成用户自己填的标签。
 */

interface Props {
  courseId: string
  concepts: Concept[]
  onAddConcept: (name: string) => void
  onRemoveConcept: (conceptId: string) => void
}

interface Draft {
  id?: string
  title: string
  body: string
  kind: NoteKind
}

const EMPTY_DRAFT: Draft = { title: '', body: '', kind: 'note' }

export function ConceptPanel({ courseId, concepts, onAddConcept, onRemoveConcept }: Props): React.JSX.Element {
  const t = useT()
  const notes = useStore((s) => s.notes)
  const notesLoadedFor = useStore((s) => s.notesLoadedFor)
  const progress = useStore((s) => s.conceptProgress)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const refreshProgress = useStore((s) => s.refreshConceptProgress)
  const saveNote = useStore((s) => s.saveNote)
  const updateNote = useStore((s) => s.updateNote)
  const removeNote = useStore((s) => s.removeNote)
  const assess = useStore((s) => s.assessConcept)
  const resetProgress = useStore((s) => s.resetConceptProgress)

  const [conceptName, setConceptName] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)

  /* 切课程时向宿主拉一次：两份数据都由宿主持有（界面只做投影）。 */
  useEffect(() => {
    void refreshNotes(courseId)
    void refreshProgress(courseId)
  }, [courseId, refreshNotes, refreshProgress])

  const progressOf = useMemo(() => {
    const map = new Map(progress.map((item) => [item.conceptId, item]))
    return (conceptId: string): (typeof progress)[number] | undefined => map.get(conceptId)
  }, [progress])

  const visibleNotes: LearningNote[] = notesLoadedFor === courseId ? notes : []

  const submitConcept = (): void => {
    const name = conceptName.trim()
    if (!name) return
    onAddConcept(name)
    setConceptName('')
  }

  const submitNote = async (): Promise<void> => {
    if (!draft || !draft.body.trim()) return
    const okDone = draft.id
      ? await updateNote(draft.id, { title: draft.title, body: draft.body, kind: draft.kind })
      : (await saveNote({ courseId, title: draft.title, body: draft.body, kind: draft.kind })) !== null
    if (okDone) setDraft(null)
  }

  return (
    <div className="wb-memory" data-testid="space-learn-memory">
      {/* ── 概念进度：两条轴并排显示 ── */}
      <section className="wb-memory-block" data-testid="space-learn-progress">
        <div className="wb-memory-head">
          <span className="wb-memory-title">{t('space.memory.progressHead')}</span>
          <span className="wb-card-meta">{t('space.memory.progressNote')}</span>
        </div>

        <div className="wb-memory-add">
          <input
            className="wb-ex-input"
            data-testid="space-learn-concept-input"
            value={conceptName}
            placeholder={t('space.memory.conceptPlaceholder')}
            onChange={(event) => setConceptName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitConcept()
            }}
          />
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-concept-add"
            disabled={!conceptName.trim()}
            onClick={submitConcept}
          >
            {t('space.memory.conceptAdd')}
          </button>
        </div>

        {concepts.length === 0 ? (
          <p className="wb-card-meta" data-testid="space-learn-concepts-empty">
            {t('space.memory.conceptsEmpty')}
          </p>
        ) : (
          <ul className="wb-memory-list" data-testid="space-learn-concepts">
            {concepts.map((concept) => {
              const entry = progressOf(concept.id)
              const level = entry?.level ?? 'unseen'
              return (
                <li className="wb-memory-row" key={concept.id} data-testid={`space-learn-concept-${concept.id}`}>
                  <div className="wb-memory-row-head">
                    <span className="wb-memory-name">{concept.name}</span>
                    <span
                      className="wb-memory-level"
                      data-level={level}
                      data-testid={`space-learn-concept-level-${concept.id}`}
                    >
                      {OBSERVATION_LABELS[level as keyof typeof OBSERVATION_LABELS] ?? level}
                    </span>
                    {/* 第二条轴：与层级并排，不合成一个标签 */}
                    {entry?.review ? (
                      <span className="wb-memory-review" data-testid={`space-learn-concept-review-${concept.id}`}>
                        {t('space.memory.review')}
                      </span>
                    ) : null}
                    <button
                      className="wb-ex-link"
                      data-testid={`space-learn-concept-remove-${concept.id}`}
                      onClick={() => onRemoveConcept(concept.id)}
                    >
                      {t('space.memory.remove')}
                    </button>
                  </div>

                  {entry?.selfAssessment ? (
                    <p className="wb-card-meta" data-testid={`space-learn-concept-self-${concept.id}`}>
                      {t('space.memory.selfLabel')}
                      {entry.selfAssessment.kind === 'got-it' ? t('space.memory.selfGotIt') : t('space.memory.selfSuspect')}
                    </p>
                  ) : null}

                  <div className="wb-memory-acts">
                    <button
                      className="wb-ex-link"
                      data-testid={`space-learn-concept-gotit-${concept.id}`}
                      onClick={() => void assess({ courseId, conceptId: concept.id, kind: 'got-it' })}
                    >
                      {t('space.memory.selfGotIt')}
                    </button>
                    <button
                      className="wb-ex-link"
                      data-testid={`space-learn-concept-suspect-${concept.id}`}
                      onClick={() => void assess({ courseId, conceptId: concept.id, kind: 'suspect' })}
                    >
                      {t('space.memory.selfSuspect')}
                    </button>
                    {entry ? (
                      <button
                        className="wb-ex-link"
                        data-testid={`space-learn-concept-reset-${concept.id}`}
                        onClick={() => void resetProgress(courseId, concept.id)}
                      >
                        {t('space.memory.recompute')}
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ── 笔记 ── */}
      <section className="wb-memory-block" data-testid="space-learn-notes">
        <div className="wb-memory-head">
          <span className="wb-memory-title">{t('space.memory.notesHead')}</span>
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-note-new"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            {t('space.memory.noteNew')}
          </button>
        </div>

        {draft ? (
          <div className="wb-memory-editor" data-testid="space-learn-note-editor">
            <input
              className="wb-ex-input"
              data-testid="space-learn-note-title"
              value={draft.title}
              placeholder={t('space.memory.noteTitle')}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            <select
              className="wb-ex-input"
              data-testid="space-learn-note-kind"
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as NoteKind })}
            >
              <option value="note">{t('space.memory.kindNote')}</option>
              <option value="summary">{t('space.memory.kindSummary')}</option>
            </select>
            <textarea
              className="wb-ex-textarea"
              data-testid="space-learn-note-body"
              rows={4}
              value={draft.body}
              placeholder={t('space.memory.notePlaceholder')}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
            <div className="wb-memory-acts">
              <button
                className="btn sm primary wb-learn-ws-submit"
                data-testid="space-learn-note-save"
                disabled={!draft.body.trim()}
                onClick={() => void submitNote()}
              >
                {t('space.memory.noteSave')}
              </button>
              <button className="btn sm wb-learn-ws-act" data-testid="space-learn-note-cancel" onClick={() => setDraft(null)}>
                {t('space.memory.cancel')}
              </button>
            </div>
          </div>
        ) : null}

        {visibleNotes.length === 0 ? (
          <p className="wb-card-meta" data-testid="space-learn-notes-empty">
            {t('space.memory.notesEmpty')}
          </p>
        ) : (
          <ul className="wb-memory-list" data-testid="space-learn-note-list">
            {visibleNotes.map((note) => (
              <li className="wb-memory-note" key={note.id} data-testid={`space-learn-note-${note.id}`}>
                <div className="wb-memory-row-head">
                  <span className="wb-memory-name">{note.title ?? t('space.memory.noteUntitled')}</span>
                  <span className="wb-memory-kind">
                    {note.kind === 'summary' ? t('space.memory.kindSummary') : t('space.memory.kindNote')}
                  </span>
                  <button
                    className="wb-ex-link"
                    data-testid={`space-learn-note-edit-${note.id}`}
                    onClick={() =>
                      setDraft({ id: note.id, title: note.title ?? '', body: note.body, kind: note.kind })
                    }
                  >
                    {t('space.memory.noteEdit')}
                  </button>
                  <button
                    className="wb-ex-link"
                    data-testid={`space-learn-note-delete-${note.id}`}
                    onClick={() => void removeNote(note.id)}
                  >
                    {t('space.memory.remove')}
                  </button>
                </div>
                <p className="wb-memory-note-body" data-testid={`space-learn-note-body-${note.id}`}>
                  {note.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
