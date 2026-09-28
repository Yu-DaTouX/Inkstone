import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { HINT_LEVELS, type ExercisePair, type ExerciseResponse, type ExerciseView, type HintLevel } from '../../../../shared/exercise'

/**
 * 练习卡（实施-25 P10）—— P09 导师页右栏的练习区。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是一条界面侧的规矩：**答案不随题目一起出现**
 * ══════════════════════════════════════════════════════════
 * 宿主下发的题目视图本来就不含答案（`shared/exercise.ts` 的 `exerciseView`），
 * 这里也不另存一份完整答案：「看完整解释」必须由用户点，点完宿主会记一笔，
 * 那一次作答就不再算独立完成（T10-2）。
 *
 * 另一个容易做错的地方是**开放题**：它没有客观判定，界面就不该显示
 * 「对 / 错」，而应当让导师去补具体反馈（`feedback.needsModel`）。
 */

interface Props {
  courseId: string
  unitId: string
  /** 把一句话发给导师（开放题的反馈、让它再出题）。 */
  onAsk: (text: string) => void
}

/** 每种题型的作答暂存。 */
interface Draft {
  optionId: string
  blanks: string[]
  pairs: Record<string, string>
  text: string
}

const EMPTY_DRAFT: Draft = { optionId: '', blanks: [], pairs: {}, text: '' }

export function ExerciseCard({ courseId, unitId, onAsk }: Props): React.JSX.Element {
  const t = useT()
  const exercises = useStore((s) => s.exercises)
  const loadedFor = useStore((s) => s.exerciseLoadedFor)
  const hints = useStore((s) => s.exerciseHints)
  const solutions = useStore((s) => s.exerciseSolutions)
  const attempts = useStore((s) => s.exerciseAttempts)
  const feedback = useStore((s) => s.exerciseFeedback)
  const refresh = useStore((s) => s.refreshExercises)
  const draft = useStore((s) => s.draftExercises)
  /*
   * 当前模型能不能看图（P19）：能力**未知**时按「不能」处理 ——
   * 宁可多提醒一次「你自己看」，也不假装模型能读图。
   */
  const modelCapabilities = useStore((s) => s.session?.capabilities)
  const canSeeImages = modelCapabilities?.input?.modalities?.includes('image') === true
  const revealHint = useStore((s) => s.revealExerciseHint)
  const revealSolution = useStore((s) => s.revealExerciseSolution)
  const submit = useStore((s) => s.submitExercise)
  const correct = useStore((s) => s.correctExerciseAttempt)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [correcting, setCorrecting] = useState(false)
  const [correction, setCorrection] = useState('')
  const [busy, setBusy] = useState(false)

  const current = `${courseId}:${unitId}`
  /* 复习挑题（P12）：把指定的一道题选中（消费一次就清掉，不抢后续切题）。 */
  const focusId = useStore((s) => s.exerciseFocus)
  const clearFocus = useStore((s) => s.clearExerciseFocus)
  useEffect(() => {
    if (loadedFor !== current) void refresh(courseId, unitId)
  }, [current, loadedFor, refresh, courseId, unitId])

  /* 切题（或题目列表变了）时，默认选中第一题。 */
  useEffect(() => {
    if (exercises.length === 0) {
      setActiveId(null)
      return
    }
    if (focusId) {
      if (exercises.some((item) => item.id === focusId)) setActiveId(focusId)
      clearFocus()
      return
    }
    if (!activeId || !exercises.some((item) => item.id === activeId)) setActiveId(exercises[0].id)
  }, [exercises, activeId, focusId, clearFocus])

  const exercise = useMemo(() => exercises.find((item) => item.id === activeId) ?? null, [exercises, activeId])
  const shownHints = exercise ? hints[exercise.id] ?? [] : []
  const solution = exercise ? solutions[exercise.id] : undefined
  const list = exercise ? attempts[exercise.id] ?? [] : []
  const latest = list.length ? list[list.length - 1] : null
  const result = exercise ? feedback[exercise.id] : undefined

  const draftOf = useCallback(
    (item: ExerciseView | null): Draft => {
      if (!item) return EMPTY_DRAFT
      const existing = drafts[item.id]
      if (existing) return existing
      return {
        optionId: '',
        blanks: item.prompt.includes('____') ? [''] : [],
        pairs: Object.fromEntries((item.pairs ?? []).map((pair) => [pair.left, ''])),
        text: ''
      }
    },
    [drafts]
  )

  const patchDraft = (id: string, patch: Partial<Draft>): void => {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftOf(exercise), ...prev[id], ...patch } }))
  }

  const nextHint = (): HintLevel | null => {
    if (!exercise) return null
    if (!exercise.hasMoreHints && shownHints.length === 0) return null
    return HINT_LEVELS[shownHints.length] ?? null
  }

  const buildResponse = (item: ExerciseView, value: Draft): ExerciseResponse | null => {
    if (item.kind === 'choice') return value.optionId ? { kind: 'choice', optionId: value.optionId } : null
    if (item.kind === 'cloze') return { kind: 'cloze', blanks: value.blanks }
    if (item.kind === 'match') {
      const pairs: ExercisePair[] = (item.pairs ?? []).map((pair) => ({ left: pair.left, right: value.pairs[pair.left] ?? '' }))
      return { kind: 'match', pairs }
    }
    if (!value.text.trim()) return null
    return item.objective ? { kind: 'text', text: value.text } : { kind: 'open', text: value.text }
  }

  const canSubmit = ((): boolean => {
    if (!exercise) return false
    const value = draftOf(exercise)
    if (exercise.kind === 'choice') return !!value.optionId
    if (exercise.kind === 'match') return (exercise.pairs ?? []).every((pair) => !!value.pairs[pair.left])
    if (exercise.kind === 'cloze') return value.blanks.some((blank) => !!blank.trim())
    return !!value.text.trim()
  })()

  const doSubmit = async (): Promise<void> => {
    if (!exercise || busy) return
    const value = draftOf(exercise)
    const response = buildResponse(exercise, value)
    if (!response) return
    setBusy(true)
    try {
      await submit(exercise.id, response)
    } finally {
      setBusy(false)
    }
  }

  const doCorrect = async (): Promise<void> => {
    if (!latest || !correction.trim()) return
    const okDone = await correct(latest.id, correction.trim())
    if (okDone) {
      setCorrection('')
      setCorrecting(false)
    }
  }

  const value = draftOf(exercise)

  return (
    <div className="wb-learn-ws-exercise" data-testid="space-learn-exercise">
      <div className="wb-ex-head">
        <Icon name="check-circle" size={12} />
        <span className="wb-ex-title">{t('space.exercise.head')}</span>
        <span className="wb-ex-count" data-testid="space-exercise-count">
          {t('space.exercise.count', { n: exercises.length })}
        </span>
        <button
          className="btn sm wb-learn-ws-act"
          data-testid="space-exercise-draft"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true)
              try {
                await draft(courseId, unitId)
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          {t('space.exercise.draft')}
        </button>
      </div>

      {exercises.length === 0 ? (
        <p className="wb-card-meta" data-testid="space-exercise-empty">
          {t('space.exercise.empty')}
        </p>
      ) : (
        <>
          <div className="wb-ex-tabs" data-testid="space-exercise-tabs">
            {exercises.map((item, index) => (
              <button
                key={item.id}
                className="wb-ex-tab"
                data-active={item.id === activeId}
                data-testid={`space-exercise-tab-${index}`}
                onClick={() => setActiveId(item.id)}
              >
                {index + 1}. {item.kindLabel}
              </button>
            ))}
          </div>

          {exercise ? (
            <div className="wb-ex-body" data-testid="space-exercise-body">
              <div className="wb-ex-kind" data-testid="space-exercise-kind">
                {exercise.kindLabel}
                {exercise.objective ? null : <span className="wb-ex-open"> · {t('space.exercise.openTag')}</span>}
              </div>
              <p className="wb-ex-prompt" data-testid="space-exercise-prompt">
                {exercise.prompt}
              </p>

              {/*
               * 题干带的图（实施-25 P19）：这里只显示**资料库引用**，不内联图片数据 ——
               * 图本身在资料页 / 成果页看；题目文件里只有 `{sourceId, version}`。
               * 当前模型能不能看图要**如实说**：不自建 OCR，也不假装能读。
               */}
              {exercise.images && exercise.images.length > 0 ? (
                <div className="wb-ex-images" data-testid="space-exercise-images">
                  {exercise.images.map((image, index) => (
                    <span
                      className="wb-ex-image"
                      key={`${image.sourceId}@${image.version}`}
                      data-testid={`space-exercise-image-${index}`}
                      title={`${image.sourceId} v${image.version}`}
                    >
                      <Icon name="image" size={12} />
                      {image.caption ?? t('space.exercise.imageRef', { version: image.version })}
                    </span>
                  ))}
                  {!canSeeImages ? (
                    <span className="wb-ex-vision" data-testid="space-exercise-vision">
                      {t('space.exercise.visionWarn')}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {/* 作答区：每题按题型给不同的输入 */}
              {exercise.kind === 'choice' ? (
                <div className="wb-ex-options" data-testid="space-exercise-options">
                  {(exercise.options ?? []).map((option) => (
                    <label key={option.id} className="wb-ex-option" data-active={value.optionId === option.id}>
                      <input
                        type="radio"
                        name={`ex-${exercise.id}`}
                        checked={value.optionId === option.id}
                        onChange={() => patchDraft(exercise.id, { optionId: option.id })}
                      />
                      <span>{option.text}</span>
                    </label>
                  ))}
                </div>
              ) : exercise.kind === 'match' ? (
                <div className="wb-ex-match" data-testid="space-exercise-match">
                  {(exercise.pairs ?? []).map((pair) => (
                    <label key={pair.left} className="wb-ex-match-row">
                      <span className="wb-ex-match-left">{pair.left}</span>
                      <select
                        value={value.pairs[pair.left] ?? ''}
                        onChange={(event) => patchDraft(exercise.id, { pairs: { ...value.pairs, [pair.left]: event.target.value } })}
                      >
                        <option value="">{t('space.exercise.pick')}</option>
                        {(exercise.pairs ?? []).map((candidate) => (
                          <option key={candidate.right} value={candidate.right}>
                            {candidate.right}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              ) : exercise.kind === 'cloze' ? (
                <div className="wb-ex-cloze" data-testid="space-exercise-cloze">
                  <label className="wb-ex-cloze-label">{t('space.exercise.blankLabel')}</label>
                  {(value.blanks.length ? value.blanks : ['']).map((blank, index) => (
                    <input
                      key={index}
                      className="wb-ex-input"
                      value={blank}
                      data-testid={`space-exercise-blank-${index}`}
                      placeholder={t('space.exercise.blankPlaceholder', { n: index + 1 })}
                      onChange={(event) => {
                        const blanks = value.blanks.length ? [...value.blanks] : ['']
                        blanks[index] = event.target.value
                        patchDraft(exercise.id, { blanks })
                      }}
                    />
                  ))}
                </div>
              ) : (
                <textarea
                  className="wb-ex-textarea"
                  data-testid="space-exercise-input"
                  rows={3}
                  value={value.text}
                  placeholder={t('space.exercise.placeholder')}
                  onChange={(event) => patchDraft(exercise.id, { text: event.target.value })}
                />
              )}

              {/* 提示：逐层给，不许跳层 */}
              {shownHints.length > 0 ? (
                <div className="wb-ex-hints" data-testid="space-exercise-hints">
                  {shownHints.map((hint) => (
                    <div key={hint.level} className="wb-ex-hint" data-testid={`space-exercise-hint-${hint.level}`}>
                      <span className="wb-ex-hint-label">
                        {t(`space.exercise.hint.${hint.level}` as 'space.exercise.hint.direction')}
                      </span>
                      {hint.text}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="wb-ex-acts">
                <button
                  className="btn sm wb-learn-ws-act"
                  data-testid="space-exercise-hint"
                  disabled={!nextHint()}
                  onClick={() => {
                    const next = nextHint()
                    if (next && exercise) void revealHint(exercise.id, next)
                  }}
                >
                  {t('space.exercise.hintBtn')}
                </button>
                <button
                  className="btn sm wb-learn-ws-act"
                  data-testid="space-exercise-solution"
                  disabled={!exercise.hasSolution || !!solution}
                  onClick={() => {
                    if (exercise) void revealSolution(exercise.id)
                  }}
                >
                  {t('space.exercise.solutionBtn')}
                </button>
                <button
                  className="btn sm primary wb-learn-ws-submit"
                  data-testid="space-exercise-submit"
                  disabled={!canSubmit || busy}
                  onClick={() => void doSubmit()}
                >
                  {t('space.exercise.submit')}
                </button>
              </div>

              {/* 完整解释：只有用户点过才出现 */}
              {solution ? (
                <div className="wb-ex-solution" data-testid="space-exercise-solution-text">
                  <div className="wb-ex-hint-label">{t('space.exercise.solutionLabel')}</div>
                  {solution}
                </div>
              ) : null}

              {/* 反馈 */}
              {result && latest ? (
                <div className="wb-ex-feedback" data-testid="space-exercise-feedback" data-verdict={result.verdict === null ? 'open' : result.verdict ? 'correct' : 'wrong'}>
                  <div className="wb-ex-verdict" data-testid="space-exercise-verdict">
                    {result.verdict === null
                      ? t('space.exercise.verdictOpen')
                      : result.verdict
                        ? t('space.exercise.verdictCorrect')
                        : t('space.exercise.verdictWrong')}
                    {result.assisted ? <span className="wb-ex-assisted"> · {t('space.exercise.assisted')}</span> : null}
                  </div>
                  {result.correctSteps.map((line, index) => (
                    <p key={`ok-${index}`} className="wb-ex-fb-line">
                      {line}
                    </p>
                  ))}
                  {result.confusions.map((line, index) => (
                    <p key={`cf-${index}`} className="wb-ex-fb-line">
                      {line}
                    </p>
                  ))}
                  {result.howToFix.map((line, index) => (
                    <p key={`fx-${index}`} className="wb-ex-fb-line">
                      {line}
                    </p>
                  ))}
                  <p className="wb-ex-fb-line">{result.nextPractice}</p>
                  {result.needsModel ? (
                    <button
                      className="btn sm wb-learn-ws-act"
                      data-testid="space-exercise-ask-model"
                      onClick={() => onAsk(t('space.exercise.askModel', { prompt: exercise.prompt.slice(0, 80) }))}
                    >
                      {t('space.exercise.askModelBtn')}
                    </button>
                  ) : null}

                  {/* 用户纠正 agent 的判断（T10-5） */}
                  <div className="wb-ex-correct">
                    {correcting ? (
                      <>
                        <textarea
                          className="wb-ex-textarea"
                          data-testid="space-exercise-correction-input"
                          rows={2}
                          value={correction}
                          placeholder={t('space.exercise.correctionPlaceholder')}
                          onChange={(event) => setCorrection(event.target.value)}
                        />
                        <div className="wb-ex-acts">
                          <button
                            className="btn sm primary wb-learn-ws-submit"
                            data-testid="space-exercise-correction-send"
                            disabled={!correction.trim()}
                            onClick={() => void doCorrect()}
                          >
                            {t('space.exercise.correctionSend')}
                          </button>
                          <button className="btn sm wb-learn-ws-act" onClick={() => setCorrecting(false)}>
                            {t('space.exercise.cancel')}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        className="wb-ex-link"
                        data-testid="space-exercise-correction-open"
                        onClick={() => setCorrecting(true)}
                      >
                        {t('space.exercise.correctionOpen')}
                      </button>
                    )}
                    {latest.correction ? (
                      <p className="wb-ex-fb-line" data-testid="space-exercise-correction-record">
                        {t('space.exercise.correctionRecorded')}
                        {latest.correction.text}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
