import { useEffect, type RefObject } from 'react'
import { useStore } from '../../state/store'
import { isModalOpen } from '../../lib/modalLayer'
import { isMacPlatform, isSessionJumpModifier, resolveSessionJump, SESSION_JUMP_HOLD_MS, SESSION_JUMP_LIMIT, shortcutOverridesFromSettings } from '../../app/shortcuts'
import { jumpIndexMap, visibleJumpPaths, type JumpRowBox } from './session-nav'
import { useSessionNav } from './session-nav-store'

export const SESSION_JUMP_ROW = '[data-sidebar-row][data-session-path]'
const JUMP_VIEWPORTS = '[data-slot="sidebar-content"], .v3-side-list, .v3-flat-shelves, .v3-side'

export function sessionJumpKeysText(index: number, mac = isMacPlatform()): string {
  return `${mac ? 'Cmd' : 'Ctrl'}+${index}`
}

function jumpRows(aside: HTMLElement | null): string[] {
  if (!aside || aside.getClientRects().length === 0) return []
  const boxes: JumpRowBox[] = []
  for (const row of aside.querySelectorAll<HTMLElement>(SESSION_JUMP_ROW)) {
    if (row.querySelector('input')) continue
    const box = row.getBoundingClientRect()
    const view = (row.parentElement?.closest<HTMLElement>(JUMP_VIEWPORTS) ?? aside).getBoundingClientRect()
    boxes.push({ path: row.dataset.sessionPath ?? '', top: box.top, bottom: box.bottom, viewport: { top: view.top, bottom: view.bottom } })
  }
  return visibleJumpPaths(boxes, SESSION_JUMP_LIMIT)
}

export function useSessionJump(asideRef: RefObject<HTMLElement | null>, onOpen: (path: string) => void): void {
  useEffect(() => {
    const mac = isMacPlatform()
    let timer = 0
    let holding = false
    const hide = (): void => {
      window.clearTimeout(timer)
      timer = 0
      if (useSessionNav.getState().jump) useSessionNav.setState({ jump: null })
    }
    const stop = (): void => {
      holding = false
      hide()
    }
    const show = (): void => {
      timer = 0
      if (!holding || isModalOpen()) return
      const paths = jumpRows(asideRef.current)
      useSessionNav.setState({ jump: paths.length ? jumpIndexMap(paths) : null })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isSessionJumpModifier(event.key, mac)) {
        if (event.repeat || holding) return
        if (event.altKey || event.shiftKey || (mac ? event.ctrlKey : event.metaKey)) return
        holding = true
        window.clearTimeout(timer)
        timer = window.setTimeout(show, SESSION_JUMP_HOLD_MS)
        return
      }
      const target = event.target as HTMLElement | null
      const index = event.defaultPrevented
        ? null
        : resolveSessionJump({
            key: event.key,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
            alt: event.altKey,
            shift: event.shiftKey,
            mac,
            composing: event.isComposing,
            repeat: event.repeat,
            altGraph: typeof event.getModifierState === 'function' ? event.getModifierState('AltGraph') : false,
            modalOpen: isModalOpen(),
            inTerminal: !!target?.closest?.('.xterm')
          }, shortcutOverridesFromSettings(useStore.getState().settings))
      if (index === null) {
        stop()
        return
      }
      const path = jumpRows(asideRef.current)[index]
      hide()
      if (!path) return
      event.preventDefault()
      event.stopPropagation()
      onOpen(path)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isSessionJumpModifier(event.key, mac) || !(mac ? event.metaKey : event.ctrlKey)) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', stop)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', stop)
      stop()
    }
  }, [asideRef, onOpen])
}
