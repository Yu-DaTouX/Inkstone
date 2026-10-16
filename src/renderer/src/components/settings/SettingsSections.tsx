import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Tabs } from '../ui'

export function SettingsSections({ sections, initial }: {
  sections: { id: string; label: string; content: ReactNode }[]
  initial?: string
}) {
  const first = initial ?? sections[0].id
  const [current, setCurrent] = useState(first)
  const [visited, setVisited] = useState(() => new Set([first]))
  const id = useId()
  const previousInitial = useRef(first)
  const select = (value: string) => {
    setVisited(old => new Set([...old, value]))
    setCurrent(value)
  }
  useEffect(() => {
    if (previousInitial.current === first) return
    previousInitial.current = first
    select(first)
  }, [first])
  return <>
    <Tabs className="settings-jump" label={sections.find(section => section.id === current)?.label}
      value={current} onChange={select}
      items={sections.map(section => ({ value: section.id, label: section.label, testId: `settings-section-${section.id}` }))} />
    {sections.map(section => <section key={section.id} id={`${id}-${section.id}`} hidden={current !== section.id}
      role="tabpanel" aria-label={section.label} tabIndex={0}>
      {visited.has(section.id) ? section.content : null}
    </section>)}
  </>
}
