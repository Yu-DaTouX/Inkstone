import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { WORK_MODES, type WorkMode } from '../../../../shared/work-mode'

/**
 * 输入框上方的消息栈：**悬着的（待投递）** + pi 队列里（已投递）的。
 *
 * 两层语义要分清：
 *   · `pendingSends` —— 还没投给 pi，用户点「插话 / 排队」之后才投递。
 *     用户 2026-09-19：「发送的消息默认悬浮在输入框上方，让用户自己选择
 *     是插话还是排队」。它只存在于渲染端（`store.pendingSends`）。
 *   · `queue.steering` / `queue.followUp` —— pi **已经收下**的（插话中 /
 *     排队中）。每行右侧的「撤回」只操作仍在队列快照中的条目：目标一旦被
 *     pi 取走就会从快照消失，不会给用户一个虚假的撤回成功。
 */
export function QueueStack() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const steerQueued = useStore((s) => s.steerQueued)
  const removeQueued = useStore((s) => s.removeQueued)
  const pendingSends = useStore((s) => s.pendingSends)
  const releaseSend = useStore((s) => s.releaseSend)
  const restoreSend = useStore((s) => s.restoreSend)
  /*
   * 回合跑着才需要「插话 / 排队」二选一；停了就只剩「发送」一个动作。
   *
   * ⚠️ 这里**故意不算 `isCompacting`**（与上面 `Composer` 里那个同名判据不同）：
   *    压缩期间模型没有在生成，“插话”没有意义 —— 卡片上只给一个
   *    「发送」（内部走 `followUp`：等压缩完再投）才是对的。
   *    `Composer` 那个判据加上压缩，是为了让这个时候按 Enter 先进待定区、
   *    不要拿着裸 prompt 去撞 pi。两处职责不同，不是写漏了。
   */
  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running
  )
  const steering = queue.steering
  const followUp = queue.followUp
  if (steering.length + followUp.length + pendingSends.length === 0) return null

  return (
    <div className="queue-stack" data-testid="queue-stack">
      {pendingSends.map((item) => (
        <div className="qrow pending" key={item.id} title={item.text} data-testid="queue-pending">
          <Icon name="send" size={12} />
          <span className="qrow-text">{item.text}</span>
          <span className="qrow-tag">{t('queue.hold')}</span>
          {roundRunning ? (
            <>
              <button
                className="qrow-jump primary"
                data-testid="pending-steer"
                title={t('queue.steerNowTip')}
                onClick={() => void releaseSend(item.id, 'steer')}
              >
                {t('queue.steerNow')}
              </button>
              <button
                className="qrow-jump"
                data-testid="pending-follow"
                title={t('queue.queueItTip')}
                onClick={() => void releaseSend(item.id, 'followUp')}
              >
                {t('queue.queueIt')}
              </button>
            </>
          ) : (
            <button
              className="qrow-jump primary"
              data-testid="pending-send"
              title={t('queue.sendNowTip')}
              onClick={() => void releaseSend(item.id, 'followUp')}
            >
              {t('queue.sendNow')}
            </button>
          )}
          <button
            className="qrow-jump"
            data-testid="pending-restore"
            title={t('queue.restoreTip')}
            onClick={() => restoreSend(item.id)}
          >
            {t('queue.restore')}
          </button>
        </div>
      ))}
      {steering.map((item) => (
        <div className="qrow steering" key={item.id} title={item.text} data-testid="queue-row">
          <Icon name="queue" size={12} />
          <span className="qrow-text">{item.text}</span>
          <span className="qrow-tag">{t('queue.inserting')}</span>
          <button
            className="qrow-jump"
            data-testid="queue-retract"
            title={t('queue.retractTip')}
            onClick={() => void removeQueued(item.id)}
          >
            {t('queue.retract')}
          </button>
        </div>
      ))}
      {followUp.map((item) => (
        <div className="qrow" key={item.id} title={item.text} data-testid="queue-row">
          <Icon name="history" size={12} />
          <span className="qrow-text">{item.text}</span>
          <button
            className="qrow-jump"
            data-testid="queue-steer"
            title={t('queue.steerTip')}
            onClick={() => void steerQueued(item.id)}
          >
            {t('queue.steer')}
          </button>
          <button
            className="qrow-jump"
            data-testid="queue-retract"
            title={t('queue.retractTip')}
            onClick={() => void removeQueued(item.id)}
          >
            {t('queue.retract')}
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * 会话工作模式选择器。把当前值和三种模式放在输入区旁，点一次即可切换。
 */
export function WorkModePicker({ buttonRef }: { buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  const t = useT()
  const stored = useStore((s) => s.workMode)
  const fallback = useStore((s) => s.settings?.defaultWorkMode ?? 'standard')
  const setWorkMode = useStore((s) => s.setWorkMode)
  const state: WorkMode = stored?.mode ?? fallback
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuWidth = 288

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    setIndex(Math.max(0, WORK_MODES.indexOf(state)))
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 6)
      })
    }
    menuRef.current?.focus()
  }, [open, state, buttonRef])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commit = (mode: WorkMode) => {
    setOpen(false)
    buttonRef.current?.focus()
    if (mode !== state) void setWorkMode(mode)
  }

  return (
    <div className="mode-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        className="ctool mode-button"
        data-testid="work-mode-button"
        data-mode={state}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t(`workMode.desc.${state}`)}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
          }
        }}
      >
        <Icon name="sparkles" size={12} />
        <span className="mode-label" data-testid="work-mode-label">
          {t(`workMode.label.${state}`)}
        </span>
        <Icon name="chevron-right" size={12} className="mode-caret chev on" />
      </button>

      {open ? (
        <div
          className="mode-menu"
          role="menu"
          data-testid="work-mode-menu"
          data-mode={state}
          ref={menuRef}
          tabIndex={-1}
          style={{ width: menuWidth, ...(anchor ? { left: anchor.left, bottom: anchor.bottom } : {}) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((value) => (value + 1) % WORK_MODES.length)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((value) => (value - 1 + WORK_MODES.length) % WORK_MODES.length)
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              commit(WORK_MODES[index])
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              buttonRef.current?.focus()
            }
          }}
        >
          {WORK_MODES.map((mode, itemIndex) => (
            <button
              key={mode}
              role="menuitemradio"
              aria-checked={mode === state}
              tabIndex={-1}
              className={`mode-item ${itemIndex === index ? 'active' : ''} ${mode === state ? 'current' : ''}`}
              data-testid={`work-mode-option-${mode}`}
              data-mode={mode}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => commit(mode)}
            >
              <span className="mode-item-label">{t(`workMode.label.${mode}`)}</span>
              <span className="mode-item-desc">{t(`workMode.desc.${mode}`)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
