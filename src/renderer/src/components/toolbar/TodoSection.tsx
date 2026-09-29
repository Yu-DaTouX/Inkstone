import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import { goalDisplayTitle } from '../../state/goal-view'
import { Spinner } from '../ui'

export function hasTaskTileContent(s: Pick<ReturnType<typeof useStore.getState>, 'todos' | 'goal'> & { hasMessageOutputs: boolean }): boolean {
  return s.todos.length > 0 || !!s.goal?.goalId || !!s.goal?.links?.length || s.hasMessageOutputs
}

/** 任务完成数 / 总数（放在分区头部，不进 body） */
export function TodoCount() {
  const todos = useStore((s) => s.todos)
  const done = todos.filter((x) => x.done).length
  if (todos.length === 0) return null
  return (
    <span className="rp-count" data-testid="todo-count">
      {done}/{todos.length}
    </span>
  )
}

/* 任务 —— 来自会话里的 custom entry（panel_todos） */

/**
 * 任务栏 —— 进度条 + 逐行落位。
 *
 * ── 用户要求 ──
 * 「假设你列出五个任务 已完成两个 再执行当前任务时 显示一个进度条 并加入动画」
 *
 * 所以三件事：
 *   ① **进度条始终显示**（原先只有 ≥ 4 个任务才显示）——
 *      5 个任务完成 2 个时它不是装饰，而是「还剩多少」的唯一提示。
 *   ② 「当前正在做的那一条」要能认出来：
 *      显式 `status` 优先；只有老数据才退回「第一个未完成」，
 *      而且**要求回合真的在跑**（见下面 activeIdx）。
 *      它带一个转动的 spinner + 左条强调色 + 名字高亮。
 *   ③ 动画：
 *      · 进度条宽度变化用 transition（不是瞬跳）
 *      · 刚被勾完的那一条闪一下（确认反馈）
 *      · 当前条目的左条呼吸 + 进度条上有一道扫光
 */
export function TodoSection() {
  const t = useT()
  const todos = useStore((s) => s.todos)
  const goal = useStore((s) => s.goal)
  const hasMessageOutputs = useStore((s) => s.messages.some((message) =>
    !!message.artifacts?.length || (message.role === 'user' && !!message.images?.length)
  ))
  /**
   * 回合是否真的在跑 —— 「正在进行」的兜底判据（见下面 activeIdx）。
   *
   * `isStreaming` 在工具执行期间是 false（见 shared/ipc.ts 的注释），
   * 所以两个都要看，否则「调工具的那几十秒」会被当成已经停下。
   */
  const agentRunning = useStore(
    (s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true
  )
  /** 全部任务清单快照（含最新）——历史任务模块用 */
  const history = useStore((s) => s.todoHistory)
  const scrollToTurn = useStore((s) => s.scrollToTurn)
  /** 历史任务折叠模块是否展开（默认收起） */
  const [histOpen, setHistOpen] = useState(false)
  const done = useMemo(() => todos.filter((x) => x.done).length, [todos])

  /*
   * 任务栏的展开态（用户要求：「当任务完成时自动收起任务工具栏」）。
   * 条件是**从“未全部完成”变为“全部完成”**那一刻收起；新任务出现时再展开。
   * 用受控 open 传给 Section（之前 Section 自己管，外面插不进去）。
   */
  const [open, setOpen] = useState(true)
  const prevTodoCount = useRef(todos.length)
  useEffect(() => {
    /* 从无任务会话切回有任务会话时，任务本体不能继承上一份空态的收起状态。 */
    if (todos.length > 0 && prevTodoCount.current === 0) setOpen(true)
    prevTodoCount.current = todos.length
  }, [todos.length])
  const allDone = todos.length > 0 && done === todos.length
  const prevAllDone = useRef(allDone)
  useEffect(() => {
    if (allDone && !prevAllDone.current) setOpen(false)
    else if (!allDone && prevAllDone.current) setOpen(true)
    prevAllDone.current = allDone
  }, [allDone])

  /*
   * 记住上一条被勾完的，用来给它加一下高亮闪动。
   *
   * 为什么要记「上一条」而不是直接看 done：勾完的条目不会消失，
   * 光靠 done 无法区分「刚勾的」与「早就勾的」。
   */
  const prevDone = useRef<Set<number>>(new Set())
  const [justDone, setJustDone] = useState<Set<number>>(new Set())

  useEffect(() => {
    const cur = new Set(todos.map((x, i) => (x.done ? i : -1)).filter((i) => i >= 0))
    const fresh = new Set<number>()
    for (const i of cur) if (!prevDone.current.has(i)) fresh.add(i)
    prevDone.current = cur
    // 首次渲染时不要把全部已完成当成「刚完成」
    if (cur.size && fresh.size === cur.size) return
    if (fresh.size === 0) return
    setJustDone(fresh)
    const id = setTimeout(() => setJustDone(new Set()), 900)
    return () => clearTimeout(id)
  }, [todos])

  if (todos.length === 0) {
    if (!hasTaskTileContent({ todos, goal, hasMessageOutputs })) return null
    return <><GoalTaskSummary /><Section titleKey="rp.todo" testId="rp-todo"><GoalOutputs /></Section></>
  }

  const pct = todos.length ? (done / todos.length) * 100 : 0
  /*
   * 「当前正在做」的那一条 —— 决定哪一行带 active + spinner。
   *
   * ⚠️ 以前是一句 `findIndex((x) => !x.done)`：只要还有没做完的任务，
   *    界面上就**永远**有一条「正在进行」在转 —— agent 停了、报错了、
   *    用户中断了，它照转。那不是状态，是猜测（方案 4.5）。
   *
   * 现在分两步：
   *   ① pi 侧的清单带**显式 `status`** 时以它为准（有人 running 就是它；
   *      有状态但没人 running → 真的没有正在做的那条）；
   *   ② 只有 `{text, done}` 的老数据退回推断，但**要求回合真的在跑** ——
   *      没在跑时，那些没做完的是「还没做」，不是「正在做」。
   */
  const activeIdx = (() => {
    const explicit = todos.findIndex((x) => x.status === 'running')
    if (explicit >= 0) return explicit
    if (todos.some((x) => x.status !== undefined)) return -1
    if (!agentRunning) return -1
    return todos.findIndex((x) => !x.done)
  })()
  const active = activeIdx >= 0 ? todos[activeIdx] : null

  return (
    <>
    <GoalTaskSummary />
    <Section
      titleKey="rp.todo"
      testId="rp-todo"
      open={open}
      onOpenChange={setOpen}
      extra={
        <span className="rp-count" data-testid="todo-count">
          {done}/{todos.length}
        </span>
      }
    >
      <div className="rp-todo-scroll">
      {/* 进度条：**总是**显示（用户要的就是“已完成两个、五个任务”的比例感） */}
      <div
        className={`rp-meter ${active ? 'busy' : ''}`}
        data-testid="todo-meter"
        data-pct={Math.round(pct)}
        title={t('rp.todoProgress', { done, total: todos.length })}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      {/*
        正在进行的任务**在任务本体上显示**（用户要求：「不要单独开一栏」）。
        这里只剩下「全部完成」的提示 —— 它不属于任何一个任务行。
        原先这里有一行 .rp-todo-now 重复了一遍当前任务名，
        与下面列表里那一行是同一件事，白占一行。
      */}
      {!active ? (
        <div className="rp-todo-all" data-testid="todo-all-done">
          <span className="rp-all-done">{t('rp.todoAllDone')}</span>
        </div>
      ) : null}

      <div className="rp-todos">
        {todos.map((todo, i) => {
          const isActive = i === activeIdx
          /** 受阻：只有数据真的标了 blocked 才显示（方案 7.1） */
          const blocked = todo.status === 'blocked'
          return (
            <div
              key={i}
              /*
               * 行类名：
               *   done      已完成（删除线 + 绿勾）
               *   todo-open 未完成
               *   active    当前正在做（行内会显示「正在进行」+ spinner）
               *   flash     刚被勾完（闪一下）
               * `--i` 给 CSS 做逐行落位
               */
              className={`rp-todo ${todo.done ? 'done' : blocked ? 'blocked' : 'todo-open'} ${isActive ? 'active' : ''} ${justDone.has(i) ? 'flash' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-done={todo.done ? '1' : '0'}
              data-active={isActive ? '1' : '0'}
              data-blocked={blocked ? '1' : '0'}
              title={todo.text}
            >
              <span className="rp-running-mark" aria-hidden />
              <span className="rp-box" aria-hidden>
                {todo.done ? <Icon name="check" size={12} /> : blocked ? <Icon name="alert-circle" size={12} /> : null}
              </span>
              <span className="rp-text">{todo.text}</span>
              {isActive ? (
                <span className="rp-state doing" data-testid="todo-active-label">
                  <Spinner className="rp-now-spin" />
                  {t('rp.doing')}
                </span>
              ) : blocked ? (
                <span className="rp-state blocked" data-testid="todo-blocked-label">
                  <Icon name="alert-circle" size={12} />
                  {t('rp.blocked')}
                </span>
              ) : (
                <span className="rp-state">{todo.done ? t('rp.done') : t('rp.open')}</span>
              )}
            </div>
          )
        })}
      </div>

      {/*
        历史任务（用户要求）：
          · 「如果这段对话有历史任务 就显示一个历史任务的折叠模块 如果没有就不显示」
          · 「在任务模块的旁边加入一个当前会话历史任务查看以及跳转」
        两者用同一个入口：头部的「历史 N」按钮 = 在任务模块旁边；
        点开后是折叠模块，每份清单带「跳转」。
        history 里最后一份就是**当前**这份，所以只在 length > 1 时才算有历史。
      */}
      {history.length > 1 ? (
        <div className="rp-todo-hist" data-testid="todo-history">
          <button
            className={`rp-hist-head ${histOpen ? 'open' : ''}`}
            onClick={() => setHistOpen((v) => !v)}
            aria-expanded={histOpen}
            data-testid="todo-history-toggle"
          >
            <Icon name="history" size={12} className="chev" />
            <span>{t('rp.todoHistory')}</span>
            <span className="spacer" />
            <span className="rp-count">{history.length - 1}</span>
          </button>
          {histOpen ? (
            <div className="rp-hist-body">
              {/* 新的在前（最近的一轮最可能被回看） */}
              {history
                .slice(0, -1)
                .reverse()
                .map((snap) => (
                  <div key={snap.id} className="rp-hist-item" data-testid={`todo-hist-${snap.round}`}>
                    <div className="rp-hist-meta">
                      <span className="rp-hist-round">
                        {t('rp.todoHistoryRound', { n: snap.round })}
                      </span>
                      <span className="rp-count">
                        {snap.todos.filter((x) => x.done).length}/{snap.todos.length}
                      </span>
                      <span className="spacer" />
                      {/*
                       * 跳转：滚到写这份清单时那一轮。
                       * 用 store 的 scrollToTurn（与导航轨同一个实现）——
                       * 一个应用里不该有两套「跳到第几轮」。
                       */}
                      <button
                        className="rp-hist-jump"
                        onClick={() => scrollToTurn(Math.max(0, snap.round - 1))}
                        data-testid={`todo-hist-jump-${snap.round}`}
                        title={t('rp.todoHistoryJump')}
                      >
                        {t('rp.jump')}
                      </button>
                    </div>
                    <div className="rp-hist-todos">
                      {snap.todos.map((x, j) => (
                        <div key={j} className={`rp-hist-todo ${x.done ? 'done' : ''}`} title={x.text}>
                          <span className="rp-box" aria-hidden>
                            {x.done ? <Icon name="check" size={12} /> : null}
                          </span>
                          <span className="rp-text">{x.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
      {/*
        产物 / 参考跟着任务卡片（用户要求：三合一看成一件事，默认保留任务）。
        放在清单与历史之后 —— 它们是任务的**附属信息**，先看完任务本身。
      */}
      <GoalOutputs />
    </Section>
    </>
  )
}

/** 当前目标随任务磁贴常驻，完整证据与核验仍可从目标详情查看。 */
function GoalTaskSummary() {
  const goal = useStore((s) => s.goal)
  const setGoalPopoverOpen = useStore((s) => s.setGoalPopoverOpen)
  const t = useT()
  if (!goal?.goalId) return null
  const done = goal.steps.filter((step) => step.status === 'done').length
  return (
    <div className="rp-goal-summary" data-testid="rp-goal-summary">
      <button type="button" className="rp-goal-summary-head" onClick={() => setGoalPopoverOpen(true)} title="查看目标详情与证据">
        <Icon name="checklist" size={14} />
        <strong>{goalDisplayTitle(goal)}</strong>
        <span className="rp-goal-phase">{t(`goal.${goal.phase}` as MessageKey)}</span>
      </button>
      {goal.steps.length ? (
        <>
          <div className="rp-goal-progress">目标进度 <span>{done}/{goal.steps.length}</span></div>
          <ol className="rp-goal-step-list">
            {goal.steps.slice(0, 5).map((step, index) => (
              <li key={`${index}-${step.title}`} className={`rp-goal-step ${step.status}`} title={step.title}>
                <span className="rp-goal-step-mark" aria-hidden>
                  {step.status === 'done' ? <Icon name="check" size={12} /> : step.status === 'blocked' ? <Icon name="alert-circle" size={12} /> : null}
                </span>
                <span>{step.title}</span>
              </li>
            ))}
          </ol>
          {goal.steps.length > 5 ? <button type="button" className="rp-goal-more" onClick={() => setGoalPopoverOpen(true)}>查看全部 {goal.steps.length} 步</button> : null}
        </>
      ) : null}
      {goal.verification ? <div className="rp-goal-verification">核验：{goal.verification.detail}</div> : null}
    </div>
  )
}

/**
 * 产物 / 参考的折叠组。
 *
 * 用户报：「右栏的 产物 参考 任务 的工具目前虽然是三合一 但是 UI 上看像是
 * 分离的」—— 三块并排是三张各自成卡的卡片，看不出是一回事。
 *
 * 现在它们同属**任务卡片**（`TodoSection` 的同一个 Section），产物与参考是
 * 卡片内的次级折叠，**默认收起**：用户要求「默认保留任务」，所以默认只留任务
 * 本体，产物/参考各占一行标题（行尾带条数），要看再展开。
 *
 * 收起时不渲染内容（不是藏起来）——与 Section 同一套语义：
 * 屏幕阅读器与探针不会读到看不见的内容。
 */
function OutputGroup({
  testId,
  title,
  count,
  children
}: {
  testId: string
  title: string
  count: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className={`rp-output-group ${open ? 'open' : ''}`} data-testid={testId}>
      <button
        type="button"
        className="rp-output-heading"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
      >
        <Icon name="chevron-right" size={12} className="chev" />
        <span>{title}</span>
        <span className="rp-count">{count}</span>
      </button>
      {open ? <div className="rp-output-list">{children}</div> : null}
    </section>
  )
}

/** 只展示当前会话实际登记的产物和参考；没有数据时不占磁贴空间。 */
function GoalOutputs() {
  const goalLinks = useStore((s) => s.goal?.links)
  const messages = useStore((s) => s.messages)
  const outputs = useMemo(() => {
    const byPath = new Map<string, { label: string; path: string; unavailable: boolean }>()
    for (const link of goalLinks ?? []) {
      if (link.kind === 'url') continue
      byPath.set(link.target, {
        label: link.label || link.target.split(/[\\/]/).pop() || link.target,
        path: link.target,
        unavailable: link.check?.ok === false
      })
    }
    for (const message of messages) {
      for (const artifact of message.artifacts ?? []) {
        byPath.set(artifact.path, {
          label: artifact.filename,
          path: artifact.path,
          unavailable: artifact.unavailable === true
        })
      }
    }
    return [...byPath.values()]
  }, [goalLinks, messages])
  const urls = useMemo(() => (goalLinks ?? []).filter((link) => link.kind === 'url'), [goalLinks])
  const images = useMemo(() => messages.flatMap((message) =>
    message.role === 'user' ? (message.images ?? []) : []
  ), [messages])

  if (!outputs.length && !urls.length && !images.length) return null
  return (
    <div className="rp-goal-outputs" data-testid="rp-goal-outputs">
      {outputs.length ? (
        <OutputGroup testId="rp-output-products" title="产物" count={outputs.length}>
          {outputs.slice(-6).map((output) => (
            <button
              type="button"
              className="rp-output-row"
              key={output.path}
              title={output.path}
              disabled={output.unavailable}
              onClick={() => void window.yan.openPath(output.path)}
            >
              <Icon name="folder-open" size={12} />
              <span>{output.label}</span>
              {output.unavailable ? <small>不可用</small> : null}
            </button>
          ))}
        </OutputGroup>
      ) : null}
      {urls.length || images.length ? (
        <OutputGroup testId="rp-output-references" title="参考" count={urls.length + images.length}>
          {urls.slice(-4).map((link) => (
            <button
              type="button"
              className="rp-output-row"
              key={link.target}
              title={link.target}
              onClick={() => void window.yan.browser.openExternal(link.target)}
            >
              <Icon name="external" size={12} />
              <span>{link.label || link.target}</span>
            </button>
          ))}
          {images.slice(-3).map((image, index) => (
            <div className="rp-output-row" key={`${index}-${image.mimeType}`}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={`参考图片 ${index + 1}`} />
              <span>参考图片 {index + 1}</span>
            </div>
          ))}
        </OutputGroup>
      ) : null}
    </div>
  )
}
