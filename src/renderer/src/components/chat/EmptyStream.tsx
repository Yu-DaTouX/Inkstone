import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

/**
 * 空状态。
 *
 * 这是「界面难看」的最大来源 —— 会话为空时三栏都是空的，
 * 中间一大片死寂，只有一行 12.5px 的小字。
 *
 * 重做思路：给空状态**内容**，而不是给装饰。
 *   · 一个符号（它是谁）
 *   · 一句能读懂的话
 *   · 三条可立即执行的建议（把空白变成入口）
 *   · 斜杠命令提示（发现性）
 *
 * （原来还有一行「记忆现状：N 已确认 / M 未确认」；记忆功能已移除。）
 */
export function EmptyStream() {
  const t = useT()
  const commands = useStore((s) => s.commands)

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
