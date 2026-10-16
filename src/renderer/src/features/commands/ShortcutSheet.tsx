import type { ReactElement } from 'react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { SHORTCUT_NOTE_GROUPS, type ShortcutNote } from '../../lib/host-actions'
import { Dialog, Kbd, Modal, ModalOverlay } from '../../ui'
import { useStore } from '../../state/store'
import { applyShortcutOverrides, shortcutOverridesFromSettings } from '../../app/shortcuts'
import { shortcutText } from './shortcut-text'
import './shortcut-sheet.css'

export interface ShortcutSheetProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

function Keys({ tokens }: { tokens?: readonly string[] }): ReactElement | null {
  if (!tokens?.length) return null
  return (
    <span className="sheet-keys">
      {tokens.map((token, index) => (
        <Kbd key={`${token}-${index}`}>{token}</Kbd>
      ))}
    </span>
  )
}

function NoteRow({ label, note }: { label: string; note?: string }): ReactElement {
  return (
    <div className="sheet-row sheet-row--note">
      <span className="sheet-row__label">{label}</span>
      <span className="sheet-row__note">{note}</span>
    </div>
  )
}

function KeyRow({ label, tokens }: { label: string; tokens?: readonly string[] }): ReactElement {
  return (
    <div className="sheet-row">
      <span className="sheet-row__label">{label}</span>
      <Keys tokens={tokens} />
    </div>
  )
}

export function ShortcutSheet({ isOpen, onOpenChange }: ShortcutSheetProps): ReactElement | null {
  const { lang } = useI18n()
  const t = useT()
  const text = shortcutText(lang)

  if (!isOpen) return null

  const defs = applyShortcutOverrides(shortcutOverridesFromSettings(useStore.getState().settings))

  return (
    <ModalOverlay className="sheet-overlay" isOpen onOpenChange={onOpenChange} isDismissable>
      <Modal className="sheet-modal">
        <Dialog className="sheet-dialog" title={text.title} closeLabel={text.close}>
          <p className="sheet-hint">{text.hint}</p>

          <section className="sheet-group" aria-label={text.groups.global}>
            <h3 className="sheet-group__title">{text.groups.global}</h3>
            {defs.map((def) => (
              <KeyRow key={def.id} label={text.purposes[def.purposeKey]} tokens={def.keys} />
            ))}
          </section>

          {SHORTCUT_NOTE_GROUPS.map((group) => (
            <section key={group.id} className="sheet-group" aria-label={text.groups[group.id]}>
              <h3 className="sheet-group__title">{text.groups[group.id]}</h3>
              {group.id === 'approval' ? (
                <>
                  <KeyRow label={text.approval.allow} tokens={['Alt', 'Y']} />
                  <KeyRow label={text.approval.deny} tokens={['Alt', 'N']} />
                </>
              ) : null}
              {group.rows.map((row: ShortcutNote, index) => {
                const label = t(row.labelKey as MessageKey)
                const note = row.noteKey ? t(row.noteKey as MessageKey) : undefined
                return row.keys?.length ? (
                  <KeyRow key={`${group.id}-${index}`} label={label} tokens={row.keys} />
                ) : (
                  <NoteRow key={`${group.id}-${index}`} label={label} note={note} />
                )
              })}
            </section>
          ))}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
