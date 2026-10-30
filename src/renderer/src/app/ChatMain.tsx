import { memo, useCallback, useRef, type JSX } from 'react'
import { SessionView } from '../features/session/SessionView'
import { ComposerV3 } from '../features/composer/ComposerV3'

function observeHeight(element: HTMLElement | null, onHeight: (height: number) => void): (() => void) | undefined {
  if (!element || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (entry) onHeight(Math.round(entry.contentRect.height))
  })
  observer.observe(element)
  return () => observer.disconnect()
}

export const ChatMain = memo(function ChatMain(): JSX.Element {
  const convRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useCallback((element: HTMLDivElement | null) => {
    return observeHeight(element, (height) => {
      convRef.current?.style.setProperty('--composer-h', `${height}px`)
    })
  }, [])
  return (
    <>
      <div className="v3-conv" ref={convRef}><SessionView /></div>
      <div className="v3-composer" ref={composerRef}><ComposerV3 /></div>
    </>
  )
})
