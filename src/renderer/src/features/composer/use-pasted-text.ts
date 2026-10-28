import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { isPasteAsTextShortcut, nextPastedTextName, pastedTextShouldAttach } from '../../../../shared/pasted-text'

const BYPASS_MS = 1000

export function pastedSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
}

export function usePastedTextAttach(wrapRef: RefObject<HTMLElement | null>): (text: string) => boolean {
  const t = useT()
  const bypassUntil = useRef(0)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as Node | null
      if (!target || !wrapRef.current?.contains(target)) return
      if (isPasteAsTextShortcut(event, isMac())) bypassUntil.current = Date.now() + BYPASS_MS
    }
    const onBlur = (): void => {
      bypassUntil.current = 0
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [wrapRef])

  return useCallback(
    (text: string): boolean => {
      const bypass = Date.now() <= bypassUntil.current
      bypassUntil.current = 0
      if (!pastedTextShouldAttach(text, bypass) || typeof window.yan?.savePastedText !== 'function') return false
      const store = useStore.getState()
      const name = nextPastedTextName(store.attachments.map((item) => item.name))
      void window.yan
        .savePastedText(text, name)
        .catch(() => ({ ok: false as const, error: 'write' as const }))
        .then(async (saved) => {
          const state = useStore.getState()
          if (!saved.ok) {
            state.insertIntoComposer(text)
            state.notify('warning', t('composer.pasteFailed'))
            return
          }
          await state.addFileRefPaths([saved.path])
          state.notify('info', t('composer.pasteAttached', { name: saved.name, size: pastedSizeLabel(saved.bytes) }))
        })
      return true
    },
    [t]
  )
}
