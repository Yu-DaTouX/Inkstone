import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import { useI18n, useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import {
  applyShortcutOverrides,
  findShortcutConflicts,
  shortcutOverridesFromSettings,
  type ShortcutId,
  type ShortcutOverrides
} from '../../../app/shortcuts'
import { shortcutText } from '../../commands/shortcut-text'
import { Button, cx, IconButton, KbdGroup, SettingRow } from '../../../ui'
import { SettingsGroup } from '../root/controls'
import { bindingFromKeyStroke, clearShortcutOverrides, rebindShortcut } from './bindings'
import { shortcutsText } from './shortcuts-text'
import { settingsText } from '../settings-text'
import './shortcuts.css'

function Keys({ tokens, className }: { tokens: readonly string[]; className?: string }): ReactElement {
  return <KbdGroup className={cx('settings-shortcut-keys', className)} keys={tokens} />
}

interface RecordingNotice {
  id: ShortcutId
  text: string
}

export function ShortcutsSettings(): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = shortcutsText(lang)
  const names = shortcutText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)

  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [notice, setNotice] = useState<RecordingNotice | null>(null)

  const overrides: ShortcutOverrides = useMemo(() => shortcutOverridesFromSettings(settings), [settings])
  const defs = useMemo(() => applyShortcutOverrides(overrides), [overrides])
  const conflicts = useMemo(() => findShortcutConflicts(defs), [defs])
  const hasOverrides = Object.keys(overrides).length > 0

  const persist = useCallback(
    (next: ShortcutOverrides) => {
      void patchSettings({ shortcutOverrides: next })
    },
    [patchSettings]
  )

  useEffect(() => {
    if (!recordingId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setRecordingId(null)
        setNotice(null)
        return
      }
      if (event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const tokens = bindingFromKeyStroke({
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        composing: event.isComposing,
        altGraph: typeof event.getModifierState === 'function' ? event.getModifierState('AltGraph') : false
      })
      if (!tokens) return
      const result = rebindShortcut(recordingId, tokens, overrides)
      if (result.ok) {
        persist(result.overrides)
        setRecordingId(null)
        setNotice(null)
        return
      }
      const conflictName = result.conflictId ? names.purposes[result.conflictId] : ''
      setNotice({
        id: recordingId,
        text:
          result.reason === 'conflict'
            ? text.conflictWith.replace('{name}', conflictName)
            : result.reason === 'unmodified'
              ? text.needModifier
              : text.emptyBinding
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recordingId, overrides, persist, names, text])

  return (
    <section className="settings-section" aria-label={settingsText(lang).sectionShortcuts} data-testid="v3-shortcuts-settings">
      <SettingsGroup
        title={settingsText(lang).groupShortcutsApp}
        description={text.note}
        settingId="shortcuts-keys"
        actions={
          <span className="settings-actions" data-setting-id="shortcuts-reset-all">
            <Button
              variant="secondary"
              isDisabled={!hasOverrides}
              data-testid="v3-shortcut-reset-all"
              onPress={() => {
                persist({})
                setRecordingId(null)
                setNotice(null)
              }}
            >
              {text.restoreAll}
            </Button>
          </span>
        }
      >
        <div className="settings-scroll-list">
        {defs.map((def) => {
          const modified = overrides[def.id] !== undefined
          const recording = recordingId === def.id
          const rowNotice = notice?.id === def.id ? notice.text : null
          const purpose = names.purposes[def.purposeKey]
          return (
            <SettingRow
              key={def.id}
              className="settings-row settings-shortcut"
              label={purpose}
              description={
                modified || rowNotice ? (
                  <>
                    {modified ? text.modified : null}
                    {rowNotice ? (
                      <span className="settings-row__line settings-row__desc--error" role="status" data-testid={`v3-shortcut-notice-${def.id}`}>
                        {rowNotice}
                      </span>
                    ) : null}
                  </>
                ) : undefined
              }
              data-testid={`v3-shortcut-${def.id}`}
              data-modified={modified ? '1' : '0'}
            >
              <span className="settings-shortcut-ctl">
                {def.rebindable ? (
                  <IconButton
                    variant="ghost"
                    isDisabled={!modified}
                    tooltip={text.restoreDefault}
                    aria-label={`${text.restoreDefault} · ${purpose}`}
                    data-testid={`v3-shortcut-reset-${def.id}`}
                    onPress={() => persist(clearShortcutOverrides(overrides, def.id))}
                  >
                    <RotateCcw size={16} />
                  </IconButton>
                ) : null}
                {def.rebindable ? (
                  <Button
                    variant={recording ? 'primary' : 'secondary'}
                    isDisabled={recordingId !== null && !recording}
                    data-testid={`v3-shortcut-record-${def.id}`}
                    aria-label={`${text.recording} · ${purpose}`}
                    onPress={() => {
                      setRecordingId(recording ? null : def.id)
                      setNotice(null)
                    }}
                  >
                    {recording ? text.recording : <Keys tokens={def.keys} />}
                  </Button>
                ) : (
                  <>
                    <span className="settings-shortcut-fixed">{text.fixed}</span>
                    <Keys className="settings-shortcut-fixed-keys" tokens={def.keys} />
                  </>
                )}
              </span>
            </SettingRow>
          )
        })}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={text.composerTitle}
        description={text.composerNote}
        settingId="shortcuts-composer"
      >
        <SettingRow className="settings-row settings-shortcut" label={t('sheet.inputSteer')} description={t('sheet.inputSteerNote')} data-testid="v3-shortcut-composer-steer">
          <span className="settings-shortcut-ctl">
            <span className="settings-shortcut-fixed">{text.fixed}</span>
            <Keys className="settings-shortcut-fixed-keys" tokens={['Enter']} />
          </span>
        </SettingRow>
        <SettingRow className="settings-row settings-shortcut" label={t('sheet.inputQueue')} description={t('sheet.inputQueueNote')} data-testid="v3-shortcut-composer-queue">
          <span className="settings-shortcut-ctl">
            <span className="settings-shortcut-fixed">{text.fixed}</span>
            <span className="settings-shortcut-keys settings-shortcut-fixed-keys">
              <Keys tokens={['Ctrl', 'Q']} />
              <span className="settings-shortcut-fixed">{text.or}</span>
              <Keys tokens={['Alt', 'Enter']} />
            </span>
          </span>
        </SettingRow>
      </SettingsGroup>

      {conflicts.length ? (
        <p className="settings-row__desc settings-shortcut-status" role="status" data-testid="v3-shortcut-conflicts">
          {text.conflictFound.replace('{list}', conflicts.join(', '))}
        </p>
      ) : null}
    </section>
  )
}
