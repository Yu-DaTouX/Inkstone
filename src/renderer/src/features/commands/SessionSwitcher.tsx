import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { SessionSummary } from '../../../../shared/ipc'
import { effectiveShortcutKeys, SHORTCUTS, shortcutOverridesFromSettings, type ShortcutId } from '../../app/shortcuts'
import { useUiV3 } from '../../state/ui-v3'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { CommandSurfaceBody, CommandSurfaceHeader, CommandSurfacePanel, ListRow } from '../../ui'
import { heldModifiersReleased, initialSwitcherIndex, relativeAge, stepSwitcherIndex, switcherSessions } from './session-switcher-model'
import './session-switcher.css'

interface SwitcherState {
  items: SessionSummary[]
  index: number
  keys: readonly string[]
}

type SwitchShortcut = Extract<ShortcutId, 'switchSessionNext' | 'switchSessionPrevious'>

function currentViewPath(): string | null {
  const s = useStore.getState()
  return s.peekedPath ?? s.session?.sessionFile ?? null
}

function bindingKeys(id: SwitchShortcut): readonly string[] {
  const def = SHORTCUTS.find((item) => item.id === id)
  return def ? effectiveShortcutKeys(def, shortcutOverridesFromSettings(useStore.getState().settings)) : []
}

function openSession(target: SessionSummary | undefined): void {
  if (!target || target.path === currentViewPath()) return
  useUiV3.getState().navigate({ name: 'chat' })
  void useStore.getState().switchSession(target.path)
}

export interface SessionSwitcherControl {
  state: SwitcherState | null
  step: (id: SwitchShortcut, event: KeyboardEvent) => boolean
  pick: (index: number) => void
}

export function useSessionSwitcher(): SessionSwitcherControl {
  const [state, setState] = useState<SwitcherState | null>(null)
  const ref = useRef<SwitcherState | null>(null)

  const update = useCallback((next: SwitcherState | null): void => {
    ref.current = next
    setState(next)
  }, [])

  const commit = useCallback((index?: number): void => {
    const current = ref.current
    if (!current) return
    update(null)
    openSession(current.items[index ?? current.index])
  }, [update])

  const step = useCallback((id: SwitchShortcut, event: KeyboardEvent): boolean => {
    const direction = id === 'switchSessionNext' ? 1 : -1
    const open = ref.current
    if (open) {
      update({ ...open, index: stepSwitcherIndex(open.index, open.items.length, direction) })
      return true
    }
    const path = currentViewPath()
    const items = switcherSessions(useStore.getState().sessions, path)
    const hasCurrent = !!path && items[0]?.path === path
    if (items.length < (hasCurrent ? 2 : 1)) return false
    const index = initialSwitcherIndex(items.length, direction, hasCurrent)
    const keys = bindingKeys(id)
    if (heldModifiersReleased(keys, { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey })) {
      openSession(items[index])
      return true
    }
    update({ items, index, keys })
    return true
  }, [update])

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent): void => {
      const open = ref.current
      if (open && heldModifiersReleased(open.keys, event)) commit()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const open = ref.current
      if (!open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        update(null)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        commit()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        update({ ...open, index: stepSwitcherIndex(open.index, open.items.length, event.key === 'ArrowDown' ? 1 : -1) })
      }
    }
    const onBlur = (): void => {
      if (ref.current) update(null)
    }
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [commit, update])

  return { state, step, pick: commit }
}

export function SessionSwitcher({ control }: { control: SessionSwitcherControl }): ReactElement | null {
  const { lang } = useI18n()
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const state = control.state
  if (!state) return null
  const now = Date.now()
  const currentPath = currentViewPath()
  const label = lang === 'en-US' ? 'Switch session' : '切换会话'
  return (
    <div className="session-switcher" data-testid="session-switcher">
      <CommandSurfacePanel className="session-switcher__panel">
        <CommandSurfaceHeader className="session-switcher__title">{label}</CommandSurfaceHeader>
        <CommandSurfaceBody role="listbox" aria-label={label}>
          {state.items.map((item, index) => {
            const current = item.path === currentPath
            return (
              <ListRow
                key={item.path}
                role="option"
                tabIndex={-1}
                aria-selected={index === state.index}
                data-selected={index === state.index ? '' : undefined}
                className="session-switcher__row"
                trailing={current ? (lang === 'en-US' ? 'Current' : '当前') : relativeAge(item.lastOpenedAt ?? item.lastActivityAt ?? item.updatedAt, now, lang)}
                data-testid="session-switcher-item"
                onPointerDown={(event) => {
                  event.preventDefault()
                  control.pick(index)
                }}
              >
                {manualTitles[item.id] ?? titles[item.id] ?? item.title}
              </ListRow>
            )
          })}
        </CommandSurfaceBody>
      </CommandSurfacePanel>
    </div>
  )
}
