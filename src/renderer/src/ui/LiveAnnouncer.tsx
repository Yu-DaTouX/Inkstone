import { useEffect, useState, type ReactElement } from 'react'

export type AnnouncePoliteness = 'polite' | 'assertive'

interface Message {
  text: string
  politeness: AnnouncePoliteness
}

const listeners = new Set<(message: Message) => void>()

export function announce(text: string, politeness: AnnouncePoliteness = 'polite'): void {
  if (!text) return
  for (const listener of listeners) listener({ text, politeness })
}

export function LiveAnnouncer(): ReactElement {
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')
  useEffect(() => {
    let frame = 0
    const listener = (message: Message): void => {
      const set = message.politeness === 'assertive' ? setAssertive : setPolite
      set('')
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => set(message.text))
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      cancelAnimationFrame(frame)
    }
  }, [])
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-announcer-polite">{polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-testid="live-announcer-assertive">{assertive}</div>
    </>
  )
}
