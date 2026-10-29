import { useEffect, type RefObject } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { SESSION_QUOTE_DROP_EVENT, type SessionDragItem } from '../split/split-drag'

export function useSessionQuoteDrop(targetRef: RefObject<HTMLElement | null>): void {
  const t = useT()
  useEffect(() => {
    const target = targetRef.current
    if (!target) return undefined
    const onDrop = (event: Event): void => {
      const item = (event as CustomEvent<SessionDragItem>).detail
      if (!item?.path) return
      const store = useStore.getState()
      void window.yan
        .quoteSession(item.path, item.title)
        .then(async (result) => {
          if (!result.ok) {
            store.notify('error', t('composer.quoteFailed', { name: item.title }))
            return
          }
          await useStore.getState().addFileRefPaths([result.path])
        })
        .catch(() => store.notify('error', t('composer.quoteFailed', { name: item.title })))
    }
    target.addEventListener(SESSION_QUOTE_DROP_EVENT, onDrop)
    return () => target.removeEventListener(SESSION_QUOTE_DROP_EVENT, onDrop)
  }, [targetRef, t])
}
