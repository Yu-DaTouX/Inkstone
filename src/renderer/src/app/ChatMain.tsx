import { observeHeight } from '../features/split/split-measure'
import { memo, useCallback, useRef, type JSX } from 'react'
import { SessionView } from '../features/session/SessionView'
import { ComposerV3 } from '../features/composer/ComposerV3'

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
