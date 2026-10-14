/**
 * 快捷键表（Ctrl+/）：只读对话框，分「全局 / 输入框 / 审批 / 终端」列出实际生效的键位。
 *
 * 数据同源：全局组来自 `lib/host-actions.ts` 的 `KEY_BINDINGS`（命令面板的动作表用的是
 * 同一份绑定），其余三组是该文件里的说明数据 —— 两处不会各维护一份。这里只渲染，
 * 不做自定义键位。
 */
import { useRef } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { KEY_BINDINGS, SHORTCUT_NOTE_GROUPS, shortcutNoteGroupKey, type ShortcutBindingId } from '../../lib/host-actions'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Icon } from '../../icons/Icon'
import { IconButton } from '../ui'

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="shortcut-keys">
      {keys.map((key, i) => (
        <kbd className="ui-kbd" key={`${key}-${i}`}>
          {key}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const t = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panelRef, true, isTop)

  const globalRows = Object.entries(KEY_BINDINGS) as [ShortcutBindingId, (typeof KEY_BINDINGS)[ShortcutBindingId]][]

  return (
    <div
      className="modal-scrim shortcut-scrim"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={t('sheet.title')}
      data-testid="shortcut-sheet"
    >
      <div className="shortcut-sheet" ref={panelRef}>
        <div className="shortcut-head">
          <Icon name="key" size={14} />
          <h2 className="shortcut-title">{t('sheet.title')}</h2>
          <IconButton icon="close" label={t('sheet.close')} size="sm" onClick={onClose} data-testid="shortcut-close" />
        </div>
        <div className="shortcut-body">
          <section className="shortcut-group">
            <div className="shortcut-group-title">{t('sheet.group.global')}</div>
            {globalRows.map(([id, binding]) => (
              <div className="shortcut-row" key={id} data-testid="shortcut-row">
                <span className="shortcut-label">{t(binding.labelKey as MessageKey)}</span>
                <Keys keys={binding.keys} />
              </div>
            ))}
          </section>
          {SHORTCUT_NOTE_GROUPS.map((group) => (
            <section className="shortcut-group" key={group.id}>
              <div className="shortcut-group-title">{t(shortcutNoteGroupKey(group.id) as MessageKey)}</div>
              {group.rows.map((row, i) => (
                <div className="shortcut-row" key={`${group.id}-${i}`} data-testid="shortcut-row">
                  <span className="shortcut-label">
                    {t(row.labelKey as MessageKey)}
                    {row.noteKey ? <span className="shortcut-note">{t(row.noteKey as MessageKey)}</span> : null}
                  </span>
                  {row.keys ? <Keys keys={row.keys} /> : null}
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="shortcut-foot">{t('sheet.hint')}</div>
      </div>
    </div>
  )
}
