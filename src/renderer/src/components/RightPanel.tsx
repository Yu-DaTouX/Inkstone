import { useMemo, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { MessageKey } from '../i18n'
import type { QueueMode } from '../../../shared/ipc'
import { shortProject } from './rail-utils'

/**
 * 右栏 —— 常驻状态栏。
 *
 * 布局参考 OpenCode 的右侧栏（用户给的截图）：一串**小分区的堆叠**，
 * 每块只讲一件事，没有图表没有装饰：
 *
 *   上下文   用了多少 / 占了多少 / 花了多少
 *   任务      agent 的 panel_todos（与 TUI 的 /panel 同一份）
 *   队列      待投递的插话 + 投递模式（pi 的 set_steering_mode / set_follow_up_mode）
 *   扩展      扩展的 setStatus / setWidget（真实数据，不再丢掉）
 *   环境      pi 版本 / 工作目录 / 模型 / 计数
 *
 * 为什么不照抄 OpenCode 的分区名（MCP / LSP）：
 *   pi 没有 MCP 与 LSP 这两个概念，硬写上去就是**编状态**。
 *   这份界面里出现的每个数字都必须真的来自某个地方
 *   （这就是为什么「已同步 · 桌面·笔记本·手机」那条被从标题栏删掉了）。
 *
 * 默认展开，可以收起 —— 收起后宽度归零，中栏内容重新居中（不是盖上去的浮层）。
 */
export function RightPanel() {
  const t = useT()
  const open = useStore((s) => s.settings?.rightPanelOpen ?? true)
  const toggle = useStore((s) => s.toggleRightPanel)

  if (!open) return null

  return (
    <aside className="rightpanel" data-testid="rightpanel">
      <div className="rp-top">
        <span className="rp-title">{t('rp.title')}</span>
        <span className="spacer" />
        <button
          className="rp-x"
          onClick={() => void toggle()}
          title={t('rp.hide')}
          data-testid="rightpanel-hide"
        >
          <Icon name="sidebar-right" size={12} />
        </button>
      </div>

      <div className="rp-body">
        <ContextSection />
        <TodoSection />
        <QueueSection />
        <ExtSection />
        <EnvSection />
        <ActionsSection />
      </div>
    </aside>
  )
}

/* ==================================================================
   一个可折叠的小分区 —— 右栏所有块共用
   ================================================================== */

function Section({
  titleKey,
  extra,
  defaultOpen = true,
  testId,
  children
}: {
  titleKey: MessageKey
  extra?: React.ReactNode
  defaultOpen?: boolean
  testId?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const t = useT()

  return (
    <section className={`rp-sec ${open ? 'open' : ''}`} data-sec={testId} data-testid={testId}>
      <button className="rp-sec-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="chevron-right" size={12} className="chev" />
        <span className="rp-sec-title">{t(titleKey)}</span>
        <span className="spacer" />
        {extra}
      </button>
      {open ? <div className="rp-sec-body">{children}</div> : null}
    </section>
  )
}

/* ==================================================================
   上下文 —— 用多少 / 占多少 / 花了多少
   ================================================================== */

function ContextSection() {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const session = useStore((s) => s.session)

  const cu = stats?.contextUsage
  const used = cu?.tokens ?? 0
  const win = cu?.contextWindow ?? session?.model?.contextWindow ?? 0
  const pct = cu?.percent ?? (used && win ? (used / win) * 100 : 0)
  const tone = pct >= 95 ? 'err' : pct >= 85 ? 'warn' : 'ok'
  const tokens = stats?.tokens.total ?? 0
  const cost = stats?.cost ?? 0

  const nf = new Intl.NumberFormat('en-US')

  return (
    <Section titleKey="rp.context" testId="rp-context">
      <div className="rp-kv">
        <span className="rp-k" />
        <span className="rp-v big">{nf.format(tokens)}</span>
        <span className="rp-u">{t('rp.tokens')}</span>
      </div>

      <div className="rp-kv">
        <span className="rp-k" />
        <span className={`rp-v ${tone}`}>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
        <span className="rp-u">{t('rp.used')}</span>
      </div>

      <div className={`rp-meter ${tone}`} title={t('ctx.tip', {
        used: nf.format(used),
        win: nf.format(win),
        pct: pct.toFixed(1)
      })}>
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      <div className="rp-kv">
        <span className="rp-k" />
        <span className="rp-v">${cost.toFixed(2)}</span>
        <span className="rp-u">{t('rp.spent')}</span>
      </div>
    </Section>
  )
}

/* ==================================================================
   任务 —— 来自会话里的 custom entry（panel_todos）
   ================================================================== */

function TodoSection() {
  const t = useT()
  const todos = useStore((s) => s.todos)
  const done = useMemo(() => todos.filter((x) => x.done).length, [todos])

  if (todos.length === 0) return null
  const pct = (done / todos.length) * 100

  return (
    <Section
      titleKey="rp.todo"
      testId="rp-todo"
      extra={
        <span className="rp-count">
          {done}/{todos.length}
        </span>
      }
    >
      {todos.length >= 4 ? (
        <div className="rp-meter">
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="rp-todos">
        {todos.map((todo, i) => (
          <div key={i} className={`rp-todo ${todo.done ? 'done' : 'todo-open'}`} data-done={todo.done ? '1' : '0'}>
            {/* 真实勾选框：空框 = 未完成，对勾 = 已完成。
                之前只有一个空 span，已完成与未完成的区别只剩删除线 ——
                用户反馈「没有已完成或未完成的提示」。 */}
            <span className="rp-box" aria-hidden>
              {todo.done ? '✓' : ''}
            </span>
            <span className="rp-text">{todo.text}</span>
            <span className="rp-state">{todo.done ? t('rp.done') : t('rp.open')}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ==================================================================
   队列 —— pi 的投递模式 + 待投递内容
   ================================================================== */

function QueueSection() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const session = useStore((s) => s.session)
  const setSteeringMode = useStore((s) => s.setSteeringMode)
  const setFollowUpMode = useStore((s) => s.setFollowUpMode)

  const steering = session?.steeringMode ?? 'one-at-a-time'
  const followUp = session?.followUpMode ?? 'one-at-a-time'
  const pending = queue.steering.length + queue.followUp.length

  return (
    <Section titleKey="rp.queue" testId="rp-queue">
      {pending > 0 ? (
        <div className="rp-queued">
          {[...queue.steering, ...queue.followUp].map((q, i) => (
            <div key={i} className="rp-queued-row" title={q}>
              <span className="rp-queued-dot" />
              <span className="rp-text">{q}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rp-dim">{t('rp.noQueue')}</div>
      )}

      <ModeRow
        labelKey="rp.steering"
        value={steering}
        onChange={(m) => void setSteeringMode(m)}
        testId="steering-mode"
      />
      <ModeRow
        labelKey="rp.followUp"
        value={followUp}
        onChange={(m) => void setFollowUpMode(m)}
        testId="followup-mode"
      />
    </Section>
  )
}

function ModeRow({
  labelKey,
  value,
  onChange,
  testId
}: {
  labelKey: MessageKey
  value: QueueMode
  onChange: (m: QueueMode) => void
  testId: string
}) {
  const t = useT()
  const modes: QueueMode[] = ['one-at-a-time', 'all']
  const label = (m: QueueMode): string =>
    m === 'all' ? t('rp.modeAll') : t('rp.modeOne')

  return (
    <div className="rp-kv rp-mode">
      <span className="rp-k">{t(labelKey)}</span>
      <span className="spacer" />
      <button
        className="rp-switch"
        data-testid={testId}
        data-value={value}
        title={t('rp.queueTip')}
        onClick={() => onChange(value === 'all' ? 'one-at-a-time' : 'all')}
      >
        <span className={value === 'one-at-a-time' ? 'on' : ''}>{t('rp.modeOne')}</span>
        <span className={value === 'all' ? 'on' : ''}>{t('rp.modeAll')}</span>
        <span className="rp-switch-tip">{label(value)}</span>
      </button>
    </div>
  )
}

/* ==================================================================
   扩展 —— setStatus / setWidget 的真实内容
   ================================================================== */

function ExtSection() {
  const t = useT()
  const statuses = useStore((s) => s.statuses)
  const widgets = useStore((s) => s.widgets)

  const statusEntries = Object.entries(statuses)
  const widgetEntries = Object.entries(widgets)
  if (statusEntries.length === 0 && widgetEntries.length === 0) return null

  return (
    <Section titleKey="rp.ext" testId="rp-ext">
      {statusEntries.map(([k, v]) => (
        <div key={k} className="rp-kv">
          <span className="rp-k">{k}</span>
          <span className="spacer" />
          <span className="rp-v">{v}</span>
        </div>
      ))}
      {widgetEntries.map(([k, lines]) => (
        <div key={k} className="rp-widget">
          <div className="rp-widget-key">{k}</div>
          {lines.map((l, i) => (
            <div key={i} className="rp-widget-line">
              {l}
            </div>
          ))}
        </div>
      ))}
      <div className="rp-dim">{t('rp.extHint')}</div>
    </Section>
  )
}

/* ==================================================================
   环境 —— 版本 / 目录 / 模型 / 计数
   ================================================================== */

function EnvSection() {
  const t = useT()
  const info = useStore((s) => s.piInfo)
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const cwd = useStore((s) => s.settings?.cwd)
  const openSettings = useStore((s) => s.openSettings)

  return (
    <Section titleKey="rp.env" testId="rp-env">
      {info?.version ? (
        <div className="rp-kv">
          <span className="rp-k">pi</span>
          <span className="spacer" />
          <span className="rp-v">{info.version}</span>
        </div>
      ) : null}

      {session?.model ? (
        <div className="rp-kv">
          <span className="rp-k">{t('rp.model')}</span>
          <span className="spacer" />
          <span className="rp-v" title={session.model.id}>
            {session.model.name}
          </span>
        </div>
      ) : null}

      {stats ? (
        <div className="rp-kv">
          <span className="rp-k">{t('rp.counts')}</span>
          <span className="spacer" />
          <span className="rp-v">
            {stats.userMessages} / {stats.assistantMessages} / {stats.toolCalls}
          </span>
        </div>
      ) : null}

      <button className="rp-path" onClick={() => openSettings('general')} title={cwd}>
        {cwd ? shortProject(cwd) : '—'}
      </button>

      <div className="rp-dim">{t('rp.hotkeys')}</div>
    </Section>
  )
}

/* ==================================================================
   操作 —— pi 自带能力的入口
   ================================================================== */

function ActionsSection() {
  const t = useT()
  const compact = useStore((s) => s.compact)
  const copyLastReply = useStore((s) => s.copyLastReply)
  const abortRetry = useStore((s) => s.abortRetry)
  const exportHtml = useStore((s) => s.exportHtml)
  const clone = useStore((s) => s.clone)
  const session = useStore((s) => s.session)
  const streaming = !!session?.isStreaming

  return (
    <Section titleKey="rp.actions" testId="rp-actions" defaultOpen={false}>
      <div className="rp-acts">
        <Act onClick={() => void compact()} disabled={streaming} labelKey="rp.actCompact" testId="act-compact" />
        <Act onClick={() => void copyLastReply()} labelKey="rp.actCopy" testId="act-copy" />
        <Act onClick={() => void abortRetry()} labelKey="rp.actRetry" testId="act-abort-retry" />
        <Act onClick={() => void exportHtml()} labelKey="rp.actExport" testId="act-export" />
        <Act onClick={() => void clone()} disabled={streaming} labelKey="rp.actClone" testId="act-clone" />
        {session?.sessionFile ? (
          <Act
            onClick={() => void window.yan.revealPath(session.sessionFile!)}
            labelKey="rp.actReveal"
            testId="act-reveal"
          />
        ) : null}
      </div>
    </Section>
  )
}

function Act({
  onClick,
  labelKey,
  testId,
  disabled
}: {
  onClick: () => void
  labelKey: MessageKey
  testId: string
  disabled?: boolean
}) {
  const t = useT()
  return (
    <button
      className="rp-act"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={disabled ? t('picker.busy') : t(labelKey)}
    >
      {t(labelKey)}
    </button>
  )
}
