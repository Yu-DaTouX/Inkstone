import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 空状态。
 *
 * 这是「界面难看」的最大来源 —— 会话为空时三栏都是空的，
 * 中间一大片死寂，只有一行 12.5px 的小字。
 *
 * 重做思路：给空状态**内容**，而不是给装饰。
 *   · 一个符号（它是谁）
 *   · 一句能读懂的话
 *   · 记忆现状（它现在知道什么）
 *   · 三条可立即执行的建议（把空白变成入口）
 *   · 斜杠命令提示（发现性）
 */
export function EmptyStream() {
  const t = useT()
  const soul = useStore((s) => s.soul)
  const memory = useStore((s) => s.memory)
  const commands = useStore((s) => s.commands)

  const confirmed = memory.filter((m) => m.kind === 'fact').length
  const guesses = memory.filter((m) => m.kind === 'guess').length

  /** 建议：点了就填进输入框并聚焦 */
  const suggest = (text: string) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
    if (!ta) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
  }

  return (
    <div className="empty-stream">
      <div className="empty-mark" aria-hidden>
        <span>✦</span>
      </div>

      <div className="empty-title">{t('chat.empty')}</div>
      <div className="empty-hint">{t('chat.emptyHint')}</div>

      {/* 记忆现状：让「它知道什么」在开口之前就可见 */}
      <div className="empty-memory">
        <span className="empty-chip">
          <b>{confirmed}</b>
          <span>{t('mem.confirmed')}</span>
        </span>
        <span className="empty-sep">·</span>
        <span className="empty-chip plain">
          <b>{guesses}</b>
          <span>{t('mem.unconfirmed')}</span>
        </span>
        <span className="empty-sep">·</span>
        <span className="empty-chip plain">
          <span>{soul.name}</span>
        </span>
      </div>

      {/* 三条建议：把空白变成入口 */}
      <div className="empty-suggest">
        <button className="empty-sug" onClick={() => suggest(t('chat.sug1'))}>
          <Icon name="checklist" size={12} />
          <span>{t('chat.sug1')}</span>
        </button>
        <button className="empty-sug" onClick={() => suggest(t('chat.sug2'))}>
          <Icon name="search" size={12} />
          <span>{t('chat.sug2')}</span>
        </button>
        <button className="empty-sug" onClick={() => suggest(t('chat.sug3'))}>
          <Icon name="message-dots" size={12} />
          <span>{t('chat.sug3')}</span>
        </button>
      </div>

      {/* 斜杠命令：发现性 —— 用户装了扩展也未必知道有命令 */}
      {commands.length > 0 ? (
        <div className="empty-cmds">
          <span className="empty-cmds-label">{t('chat.cmds')}</span>
          {commands.slice(0, 6).map((c) => (
            <button key={c.name} className="empty-cmd" onClick={() => suggest(`/${c.name} `)} title={c.description}>
              /{c.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
