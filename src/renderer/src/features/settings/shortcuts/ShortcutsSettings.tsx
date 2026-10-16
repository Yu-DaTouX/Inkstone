/**
 * 设置 → 快捷键（v3，WP-25b 余项）。
 *
 * 展示 `app/shortcuts.ts` 的全局键位注册表（与 `ShellV3` 的实际按键分发同源），
 * 并允许逐项改绑：点某一项 → 录制新组合键 → 校验冲突 → 写入 `AppSettings.shortcutOverrides`；
 * 可单项或全部恢复默认。终端会让键（Ctrl+K/B/J）与不在注册表里的 Esc / Alt+Y/N
 * 保持固定，不提供改绑入口。
 *
 * 覆盖表经 `shortcutOverridesFromSettings` 清洗后应用；`ShellV3` 的绑定端在 `app/shortcuts.ts`
 * 侧做同样的覆盖应用（补丁见 `.tmp/v3-ui/hotspot/G2-shortcut-rebind.md`）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import {
  applyShortcutOverrides,
  findShortcutConflicts,
  shortcutOverridesFromSettings,
  type ShortcutId,
  type ShortcutOverrides
} from '../../../app/shortcuts'
import type { AppSettings } from '../../../../../shared/ipc'
import { shortcutText } from '../../commands/shortcut-text'
import { Button, Kbd } from '../../../ui'
import { bindingFromKeyStroke, clearShortcutOverrides, rebindShortcut } from './bindings'
import { shortcutsText } from './shortcuts-text'
import { settingsText } from '../settings-text'
import './shortcuts.css'

function Keys({ tokens }: { tokens: readonly string[] }): ReactElement {
  return (
    <span className="settings-shortcut-keys">
      {tokens.map((token, index) => (
        <Kbd key={`${token}-${index}`}>{token}</Kbd>
      ))}
    </span>
  )
}

interface RecordingNotice {
  id: ShortcutId
  text: string
}

export function ShortcutsSettings(): ReactElement {
  const { lang } = useI18n()
  const text = shortcutsText(lang)
  const names = shortcutText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)

  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [notice, setNotice] = useState<RecordingNotice | null>(null)

  /* 覆盖表来自设置；清洗后应用，脏值不参与展示与匹配。 */
  const overrides: ShortcutOverrides = useMemo(() => shortcutOverridesFromSettings(settings), [settings])
  const defs = useMemo(() => applyShortcutOverrides(overrides), [overrides])
  const conflicts = useMemo(() => findShortcutConflicts(defs), [defs])
  const hasOverrides = Object.keys(overrides).length > 0

  const persist = useCallback(
    (next: ShortcutOverrides) => {
      void patchSettings({ shortcutOverrides: next } as unknown as Partial<AppSettings>)
    },
    [patchSettings]
  )

  /* 录制：窗口捕获阶段截住按键，不让外壳全局分发或输入框吃掉。 */
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
      <p className="settings-note" role="note">
        {text.note}
      </p>

      <table className="settings-table">
        <thead>
          <tr>
            <th>{text.columnAction}</th>
            <th>{text.columnKeys}</th>
            <th>{text.columnState}</th>
            <th>{text.columnActions}</th>
          </tr>
        </thead>
        <tbody>
          {defs.map((def) => {
            const modified = overrides[def.id] !== undefined
            const recording = recordingId === def.id
            const rowNotice = notice?.id === def.id ? notice.text : null
            return (
              <Fragment key={def.id}>
                <tr data-testid={`v3-shortcut-${def.id}`} data-modified={modified ? '1' : '0'}>
                  <td>{names.purposes[def.purposeKey]}</td>
                  <td>
                    {def.rebindable ? (
                      <Button
                        size="sm"
                        variant={recording ? 'primary' : 'secondary'}
                        isDisabled={recordingId !== null && !recording}
                        data-testid={`v3-shortcut-record-${def.id}`}
                        aria-label={`${text.recording} · ${names.purposes[def.purposeKey]}`}
                        onPress={() => {
                          setRecordingId(recording ? null : def.id)
                          setNotice(null)
                        }}
                      >
                        {recording ? text.recording : <Keys tokens={def.keys} />}
                      </Button>
                    ) : (
                      <Keys tokens={def.keys} />
                    )}
                  </td>
                  <td>{def.rebindable ? (modified ? text.modified : text.rebindable) : text.fixed}</td>
                  <td>
                    <div className="settings-shortcut-actions">
                      {def.rebindable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          isDisabled={!modified}
                          data-testid={`v3-shortcut-reset-${def.id}`}
                          onPress={() => persist(clearShortcutOverrides(overrides, def.id))}
                        >
                          {text.restoreDefault}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {rowNotice ? (
                  <tr className="settings-shortcut-notice" data-testid={`v3-shortcut-notice-${def.id}`}>
                    <td colSpan={4} role="status">
                      {rowNotice}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      <div className="settings-shortcut-foot">
        <p className="settings-row__desc" role="status" data-testid="v3-shortcut-conflicts">
          {conflicts.length
            ? text.conflictFound.replace('{list}', conflicts.join(', '))
            : text.conflictNone}
        </p>
        <Button
          size="sm"
          variant="ghost"
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
      </div>
    </section>
  )
}
