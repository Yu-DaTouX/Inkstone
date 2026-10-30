import { useCallback, useEffect, useState, type RefObject } from 'react'
import {
  PROMPT_STASH_OPEN_EVENT,
  PROMPT_STASH_SAVE_EVENT,
  deletePromptStashEntry,
  isPromptStashShortcut,
  stashPromptInput,
  swapPromptStashInStore,
  type PromptStashEntry
} from '@/features/composer/prompt-stash'
import { usePromptStashEntries } from '@/features/composer/usePromptStash'
import { useT } from '@/i18n'
import { useStore } from '@/state/store'

export interface PromptStashAdapterInput {
  value: string
  rootRef?: RefObject<HTMLElement | null>
  onStashed?: () => void
}

export interface PromptStashAdapter {
  entries: readonly PromptStashEntry[]
  count: number
  pulseKey: number
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
  stash: () => boolean
  restore: (entry: PromptStashEntry) => void
  remove: (entry: PromptStashEntry) => void
}

export function usePromptStashAdapter(input: PromptStashAdapterInput): PromptStashAdapter {
  const t = useT()
  const entries = usePromptStashEntries()
  const notify = useStore((s) => s.notify)
  const sessionKey = useStore(
    (s) => s.peekedSessionId ?? s.session?.conversationId ?? s.session?.sessionId ?? ''
  )
  const [isOpen, setIsOpen] = useState(false)
  const [pulseKey, setPulseKey] = useState(0)
  const { value, rootRef, onStashed } = input

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((current) => !current), [])

  const stash = useCallback((): boolean => {
    const entry = stashPromptInput({
      text: value,
      attachments: useStore.getState().attachments,
      sessionKey
    })
    if (!entry) {
      notify('info', t('stash.nothing'))
      return false
    }
    onStashed?.()
    setPulseKey((key) => key + 1)
    notify('info', t('stash.saved'))
    return true
  }, [notify, onStashed, sessionKey, t, value])

  const restore = useCallback(
    (entry: PromptStashEntry): void => {
      const taken = swapPromptStashInStore(entry.id, {
        text: value,
        attachments: useStore.getState().attachments,
        sessionKey
      })
      if (!taken) return
      useStore.setState({
        attachments: taken.attachments.map((item) => ({ ...item })),
        editorInject: { text: taken.text, mode: 'replace' }
      })
      setIsOpen(false)
    },
    [sessionKey, value]
  )

  const remove = useCallback((entry: PromptStashEntry): void => {
    deletePromptStashEntry(entry.id)
  }, [])

  useEffect(() => {
    const onRequest = (): void => {
      window.setTimeout(() => setIsOpen(true), 0)
    }
    const onSave = (): void => {
      stash()
    }
    window.addEventListener(PROMPT_STASH_OPEN_EVENT, onRequest)
    window.addEventListener(PROMPT_STASH_SAVE_EVENT, onSave)
    return () => {
      window.removeEventListener(PROMPT_STASH_OPEN_EVENT, onRequest)
      window.removeEventListener(PROMPT_STASH_SAVE_EVENT, onSave)
    }
  }, [stash])

  useEffect(() => {
    const node = rootRef?.current
    if (!node) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isOpen) return
      if (!isPromptStashShortcut(event)) return
      const target = event.target
      if (!(target instanceof Node) || !node.contains(target)) return
      event.preventDefault()
      stash()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isOpen, rootRef, stash])

  return {
    entries,
    count: entries.length,
    pulseKey,
    isOpen,
    open,
    close,
    toggle,
    stash,
    restore,
    remove
  }
}
