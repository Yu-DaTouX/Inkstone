import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { TurnView } from '../chat/TurnView'
import { groupIntoTurns } from '../../../../shared/turns'
import { LearningView } from './LearningView'
import { ExerciseCard } from './ExerciseCard'
import { ReviewPanel } from './ReviewPanel'
import { AudioCard } from './AudioCard'

/**
 * 导师页面（实施-25 P09）—— 左路线 / 中导师对话 / 右教材与练习。
 *
 * ══════════════════════════════════════════════════════════
 * 三栏各自的**唯一职责**（以及谁说了算）
 * ══════════════════════════════════════════════════════════
 *   · 左：章节与状态 —— 复用 P07 的课程与路线（`LearningView`），
 *     位置**不在这一层存副本**：当前学到哪以 `StudySession` 为准（评审给 P09 的风险点）。
 *   · 中：导师对话 —— 就是**当前这个会话**的对话（同一主导师、同一条时间线），
 *     底部还有全局输入框；这里显示最近几轮 + 学习时固定的五个动作。
 *   · 右：教材与练习 —— 定位到 P03 的**真实区间**（字符偏移，不是页码）；
 *     选中一段可以解释 / 举例 / 提问 / 出题。
 *
 * 两条不能含糊的边界：
 *   · **作答必须记进学习状态**（P08 的 `answer`）再发出去 —— 否则阶段永远停在
 *     「等你作答」，而闸门会一直拦着自动续跑（功能看起来像卡死）。
 *   · 「跳过」是**换一节**（`start` 到下一单元），不是把等待硬翻过去；
 *     等待只能由作答离开（P08 的转移表）。
 */

/*
 * 三栏的档位**由容器宽度决定，不看视口**。
 *
 * 为什么不能用 `@media`：导师页在中栏（工作台）里，而中栏宽度随左栏/右工具面板浮动
 *（实测 1280 窗口下工作台只有 620px，而视口是 1280）—— 用视口宽度判断的话，
 * 三栏会在 620px 里被排成「中栏 0px」，看起来像功能没了。
 */
type WorkspaceLayout = 'wide' | 'mid' | 'narrow'

const LAYOUT_WIDE = 980
const LAYOUT_MID = 520

const CHAT_TAIL = 6
/** 教材预览：这一节前后多给一点上下文，但别把整本书铺进来。 */
const MATERIAL_BEFORE = 200
const MATERIAL_AFTER = 800

interface Props {
  spaceId?: string | null
}

interface MaterialState {
  text: string
  /** 展示文本在整份正文里的起始偏移（选中区间换算要用）。 */
  start: number
  version?: number
  truncated?: boolean
  error?: string
  sourceTitle?: string
}

export function LearningWorkspace({ spaceId }: Props): React.JSX.Element {
  const t = useT()
  const courses = useStore((s) => s.courses)
  const status = useStore((s) => s.studyStatus)
  const refreshStatus = useStore((s) => s.refreshStudyStatus)
  const startStudy = useStore((s) => s.startStudy)
  const answerStudy = useStore((s) => s.answerStudy)
  const pauseStudy = useStore((s) => s.pauseStudy)
  const resumeStudy = useStore((s) => s.resumeStudy)
  const stopStudy = useStore((s) => s.stopStudy)
  const send = useStore((s) => s.send)
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => s.session?.isStreaming || s.session?.isAgentRunning)
  const openRef = useStore((s) => s.openLibraryRef)

  const [material, setMaterial] = useState<MaterialState | null>(null)
  const [selection, setSelection] = useState<{ text: string; start: number; end: number } | null>(null)
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [layout, setLayout] = useState<WorkspaceLayout>('narrow')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const session = status?.session ?? null
  const course = useMemo(
    () => (session ? courses.find((item) => item.id === session.courseId) ?? null : null),
    [courses, session]
  )
  const unit = useMemo(
    () => (course && session ? course.units.find((item) => item.id === session.unitId) ?? null : null),
    [course, session]
  )
  const unitIndex = course && unit ? course.units.findIndex((item) => item.id === unit.id) : -1
  const nextUnit = course && unitIndex >= 0 ? course.units[unitIndex + 1] ?? null : null

  /* 打开导师页就拉一次学习状态：宿主是事实源（另一处 / 上一轮可能改过阶段）。 */
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  /* 容器宽度 → 档位（三栏 / 左+上下 / 单列），见 `WorkspaceLayout` 的注释。 */
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setLayout(width >= LAYOUT_WIDE ? 'wide' : width >= LAYOUT_MID ? 'mid' : 'narrow')
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /*
   * 教材：按**引用那一版**取正文，并多带一点上下文。
   *
   * 请求长度必须覆盖到这一节的结束位置 —— 截短了会让「这一节」显示不全，
   * 而右侧恰好是用户用来核对原文的地方（P03 的不变量：引用绑 identity + version）。
   */
  const sourceRef = unit?.sources[0]
  useEffect(() => {
    let alive = true
    if (!sourceRef) {
      setMaterial(null)
      return
    }
    const locatorEnd = sourceRef.locator?.end ?? 0
    const maxChars = Math.max(locatorEnd + MATERIAL_AFTER, 1600)
    void openRef({ sourceId: sourceRef.sourceId, version: sourceRef.version }, maxChars).then((res) => {
      if (!alive) return
      if (!res || res.outcome !== 'ok' || !res.text) {
        setMaterial({ text: '', start: 0, error: res?.outcome === 'missing' ? 'missing' : 'empty' })
        return
      }
      const absoluteStart = Math.max(0, (sourceRef.locator?.start ?? 0) - MATERIAL_BEFORE)
      setMaterial({
        text: res.text.slice(absoluteStart),
        start: absoluteStart,
        version: res.version?.version,
        truncated: res.truncated === true,
        sourceTitle: res.source?.title
      })
    })
    return () => {
      alive = false
    }
  }, [sourceRef?.sourceId, sourceRef?.version, sourceRef?.locator?.start, sourceRef?.locator?.end, openRef])

  const turns = useMemo(() => {
    const streamingId = streaming ? messages[messages.length - 1]?.id : undefined
    return groupIntoTurns(messages, streamingId).slice(-CHAT_TAIL)
  }, [messages, streaming])

  /**
   * 读选中片段。
   *
   * 只认**正文容器里**的选区（别处选中不该弹出教材动作），并把偏移换算成
   * 整份正文里的绝对字符位置 —— 这样交给导师的引用是能对回原文的，
   * 而不是「大概在开头那一块」。
   */
  const readSelection = useCallback(() => {
    const root = bodyRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      setSelection(null)
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      setSelection(null)
      return
    }
    const base = material?.start ?? 0
    const start = base + Math.min(range.startOffset, range.endOffset)
    const end = base + Math.max(range.startOffset, range.endOffset)
    setSelection({ text, start, end })
  }, [material?.start])

  const where = session && course && unit
    ? `${t('space.tutor.studyThis')}：《${course.title}》·第 ${unitIndex + 1}/${course.units.length} 节「${unit.title}」`
    : ''

  const ask = async (what: string): Promise<void> => {
    await send(where ? `${where}。${what}` : what)
  }

  const askWithSelection = async (what: string): Promise<void> => {
    if (!selection) return
    const located = t('space.tutor.materialLocated', { start: selection.start, end: selection.end })
    await ask(`${what}（原文 ${located}：「${selection.text}」）`)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const submitAnswer = async (): Promise<void> => {
    const text = answer.trim()
    if (!text || sending) return
    setSending(true)
    try {
      /*
       * 顺序不能反：**先**把这次作答记进学习状态（P08 的 `answer`），
       * 再把它作为消息发出去。反过来的话，模型先看到答复、阶段却还停在
       * 「等你作答」，自动续跑闸门会一直拦着（看起来像卡死）。
       */
      const recorded = await answerStudy(text)
      if (!recorded) return
      setAnswer('')
      await send(text)
    } finally {
      setSending(false)
    }
  }

  const skipToNext = async (): Promise<void> => {
    if (!course || !nextUnit) return
    const started = await startStudy({ courseId: course.id, unitId: nextUnit.id })
    if (started) await ask(`这一节先跳过，接着讲「${nextUnit.title}」。`)
  }

  const waiting = status?.waiting === true

  return (
    <div className="wb-learn-ws" data-layout={layout} data-testid="space-learning" ref={rootRef}>
      {/* 左：章节与状态（课程与路线的编辑能力完整保留在这里） */}
      <div className="wb-learn-ws-left" data-testid="space-learn-ws-left">
        <LearningView
          spaceId={spaceId}
          onStudyUnit={(courseId, unitId) => {
            void startStudy({ courseId, unitId })
          }}
        />
      </div>

      {/* 中：导师对话（同一个会话，不换人） */}
      <section className="wb-learn-ws-chat" data-testid="space-learn-chat">
        <header className="wb-learn-ws-head">
          <Icon name="chat-round" size={14} />
          <span className="wb-learn-ws-title">{t('space.tutor.chatHead')}</span>
          <span className="wb-learn-ws-sub" data-testid="space-learn-chat-where">
            {session && course && unit
              ? `第 ${unitIndex + 1}/${course.units.length} 节 · ${status?.resume?.phaseLabel ?? ''}`
              : t('space.tutor.chatSame')}
          </span>
        </header>

        <div className="wb-learn-ws-stream" data-testid="space-learn-chat-stream">
          {turns.length === 0 ? (
            <p className="wb-card-empty" data-testid="space-learn-chat-empty">
              {t('space.tutor.chatEmpty')}
            </p>
          ) : (
            <>
              <p className="wb-learn-ws-note">{t('space.tutor.chatEarlier')}</p>
              {turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} streaming={turn.kind === 'assistant' && !!turn.streaming} />
              ))}
            </>
          )}
        </div>

        <div className="wb-learn-ws-acts" data-testid="space-learn-actions">
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-act-simpler"
            disabled={!unit}
            onClick={() => void ask('这一段再讲简单一点，用更直白的话。')}
          >
            {t('space.tutor.actSimpler')}
          </button>
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-act-example"
            disabled={!unit}
            onClick={() => void ask('换一个例子讲这一段。')}
          >
            {t('space.tutor.actExample')}
          </button>
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-act-hint"
            disabled={!waiting}
            title={waiting ? '' : t('space.tutor.needStudy')}
            onClick={() => void ask('我还没答上来，给个提示（不要直接给答案）。')}
          >
            {t('space.tutor.actHint')}
          </button>
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-act-reveal"
            disabled={!unit}
            onClick={() => void ask('直接给我完整解释。')}
          >
            {t('space.tutor.actReveal')}
          </button>
          <button
            className="btn sm wb-learn-ws-act"
            data-testid="space-learn-act-skip"
            disabled={!nextUnit}
            title={nextUnit ? '' : t('space.tutor.chatSame')}
            onClick={() => void skipToNext()}
          >
            {t('space.tutor.actSkip')}
          </button>
        </div>

        {/* 作答：只有「等你作答」时才出现 —— 平时发言走底部输入框 */}
        {waiting ? (
          <div className="wb-learn-ws-answer" data-testid="space-learn-answer">
            <div className="wb-learn-ws-answer-head">
              <Icon name="check-circle" size={12} />
              <span data-testid="space-learn-answer-title">{t('space.tutor.answerTitle')}</span>
            </div>
            {status?.resume?.question ? (
              <p className="wb-learn-ws-question" data-testid="space-learn-answer-question">
                {status.resume.question}
              </p>
            ) : null}
            <textarea
              className="wb-learn-ws-answer-input"
              data-testid="space-learn-answer-input"
              rows={3}
              value={answer}
              placeholder={t('space.tutor.answerPlaceholder')}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <div className="wb-learn-ws-answer-foot">
              <span className="wb-card-meta">{t('space.tutor.answerNote')}</span>
              <button
                className="btn sm primary wb-learn-ws-submit"
                data-testid="space-learn-answer-send"
                disabled={!answer.trim() || sending}
                onClick={() => void submitAnswer()}
              >
                {t('space.tutor.answerSend')}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* 右：教材与练习 */}
      <aside className="wb-learn-ws-material" data-testid="space-learn-material">
        <header className="wb-learn-ws-head">
          <Icon name="folder-open" size={14} />
          <span className="wb-learn-ws-title">{t('space.tutor.materialHead')}</span>
          {sourceRef?.locator ? (
            <span className="wb-learn-ws-sub" data-testid="space-learn-material-located">
              {t('space.tutor.materialLocated', { start: sourceRef.locator.start, end: sourceRef.locator.end })}
            </span>
          ) : null}
          {session && unit ? (
            <div className="wb-learn-ws-material-actions">
              <button
                className="btn sm wb-learn-ws-act"
                data-testid="space-learn-pause"
                onClick={() => void (session.paused ? resumeStudy() : pauseStudy())}
              >
                {session.paused ? t('space.tutor.resume') : t('space.tutor.pause')}
              </button>
              <button className="btn sm wb-learn-ws-act" data-testid="space-learn-stop" onClick={() => void stopStudy()}>
                {t('space.tutor.stop')}
              </button>
            </div>
          ) : null}
        </header>

        {!session || !unit ? (
          <p className="wb-card-empty" data-testid="space-learn-material-pick">
            {t('space.tutor.materialPick')}
          </p>
        ) : !sourceRef ? (
          <p className="wb-card-empty" data-testid="space-learn-material-empty">
            {t('space.tutor.materialEmpty')}
          </p>
        ) : material?.error ? (
          <p className="wb-card-empty" data-testid="space-learn-material-error">
            {t('space.tutor.materialError')}
          </p>
        ) : (
          <>
            <div
              className="wb-learn-ws-text"
              data-testid="space-learn-material-text"
              ref={bodyRef}
              onMouseUp={readSelection}
              onKeyUp={readSelection}
            >
              {material?.text ?? ''}
            </div>
            {material?.truncated ? (
              <p className="wb-card-meta" data-testid="space-learn-material-cut">
                {t('space.tutor.materialCut')}
              </p>
            ) : null}

            {selection ? (
              <div className="wb-learn-ws-sel" data-testid="space-learn-selection">
                <span className="wb-card-meta" data-testid="space-learn-selection-quote">
                  {t('space.tutor.selQuote')}
                  {selection.text.slice(0, 60)}
                  {selection.text.length > 60 ? '…' : ''}
                </span>
                <div className="wb-learn-ws-sel-acts">
                  <button
                    className="btn sm wb-learn-ws-act"
                    data-testid="space-learn-sel-explain"
                    onClick={() => void askWithSelection('解释这一段。')}
                  >
                    {t('space.tutor.selExplain')}
                  </button>
                  <button
                    className="btn sm wb-learn-ws-act"
                    data-testid="space-learn-sel-example"
                    onClick={() => void askWithSelection('就这一段举个例子。')}
                  >
                    {t('space.tutor.selExample')}
                  </button>
                  <button
                    className="btn sm wb-learn-ws-act"
                    data-testid="space-learn-sel-ask"
                    onClick={() => void askWithSelection('关于这一段，我有个问题：')}
                  >
                    {t('space.tutor.selAsk')}
                  </button>
                  <button
                    className="btn sm wb-learn-ws-act"
                    data-testid="space-learn-sel-exercise"
                    onClick={() => void askWithSelection('就这一段出一道题给我练。')}
                  >
                    {t('space.tutor.selExercise')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="wb-card-meta" data-testid="space-learn-selection-hint">
                {t('space.tutor.selHint')}
              </p>
            )}
          </>
        )}

        {session && course && unit ? (
          <ExerciseCard courseId={course.id} unitId={unit.id} onAsk={(text) => void ask(text)} />
        ) : (
          <div className="wb-learn-ws-exercise" data-testid="space-learn-exercise">
            <div className="wb-learn-ws-answer-head">
              <Icon name="check-circle" size={12} />
              <span>{t('space.tutor.exerciseHead')}</span>
            </div>
            <p className="wb-card-meta">{t('space.tutor.exerciseSoon')}</p>
          </div>
        )}

        {/*
         * 错题与复习（P12）：放在练习卡下面 —— 它挑出的题就是要拿到上面那张卡里去做的。
         * 没有开始学某一节时（`course` 为空）就不显示：复习本来就长在课程上。
         */}
        {course ? <ReviewPanel courseId={course.id} /> : null}

        {/*
         * 语音（P20）：不做识别与朗读，只说路径 + 把外部转写登记到同一门课。
         * 放在复习卡下面：它也是一件「回头再看 / 再听一遍」的事。
         */}
        {course ? (
          <AudioCard
            courseId={course.id}
            {...(unit?.sources?.[0]?.sourceId ? { sourceId: unit.sources[0].sourceId } : {})}
            {...(unit?.sources?.[0]?.version ? { version: unit.sources[0].version } : {})}
          />
        ) : null}
      </aside>
    </div>
  )
}
