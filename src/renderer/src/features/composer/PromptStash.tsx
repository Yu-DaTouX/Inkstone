import { useCallback, useEffect, useState, type RefObject } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import {
  PROMPT_STASH_OPEN_EVENT,
  PROMPT_STASH_SAVE_EVENT,
  deletePromptStashEntry,
  isPromptStashShortcut,
  stashPromptInput,
  swapPromptStashInStore,
  type PromptStashEntry
} from './prompt-stash'
import { StashMenu } from './StashMenu'
import { usePromptStashEntries } from './usePromptStash'

export interface PromptStashProps {
  value: string
  onClear: () => void
  rootRef: RefObject<HTMLElement | null>
}

export function PromptStash({ value, onClear, rootRef }: PromptStashProps) {
  const t = useT()
  const notify = useStore((s) => s.notify)
  const entries = usePromptStashEntries()
  const sessionKey = useStore((s) => s.peekedSessionId ?? s.session?.conversationId ?? s.session?.sessionId ?? '')
  const [isOpen, setIsOpen] = useState(false)

  const stashCurrent = useCallback((): boolean => {
    const entry = stashPromptInput({
      text: value,
      attachments: useStore.getState().attachments,
      sessionKey
    })
    if (!entry) {
      notify('info', t('stash.nothing'))
      return false
    }
    onClear()
    notify('info', t('stash.saved'))
    return true
  }, [notify, onClear, sessionKey, t, value])

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
      stashCurrent()
    }
    window.addEventListener(PROMPT_STASH_OPEN_EVENT, onRequest)
    window.addEventListener(PROMPT_STASH_SAVE_EVENT, onSave)
    return () => {
      window.removeEventListener(PROMPT_STASH_OPEN_EVENT, onRequest)
      window.removeEventListener(PROMPT_STASH_SAVE_EVENT, onSave)
    }
  }, [stashCurrent])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isOpen) return
      if (!isPromptStashShortcut(event)) return
      const root = rootRef.current
      const target = event.target
      if (!root || !(target instanceof Node) || !root.contains(target)) return
      event.preventDefault()
      stashCurrent()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isOpen, rootRef, stashCurrent])

  return (
    <StashMenu
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={rootRef}
      scopeRef={rootRef}
      entries={entries}
      onRestore={restore}
      onDelete={remove}
    />
  )
}
