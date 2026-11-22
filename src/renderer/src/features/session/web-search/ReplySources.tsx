import { useEffect, useRef, useState, type JSX } from 'react'
import { Button, Collapsible, CollapsibleHeader, CollapsiblePanel } from '../../../ui'
import { useStore } from '../../../state/store'
import { useCitationIndex } from './citations'
import { useWebSearchText } from './text'
import './reply-sources.css'

function linksOf(body: HTMLElement): HTMLAnchorElement[] {
  return [...body.querySelectorAll<HTMLAnchorElement>('[data-citation-reply] a[data-citation-number]')].filter((link) => link.closest('.v3-assistant-body') === body)
}

export function ReplySources(): JSX.Element | null {
  const index = useCitationIndex()
  const tt = useWebSearchText()
  const openLink = useStore((s) => s.openLink)
  const slot = useRef<HTMLDivElement>(null)
  const [numbers, setNumbers] = useState<number[]>([])
  useEffect(() => {
    const body = slot.current?.closest<HTMLElement>('.v3-assistant-body')
    if (!body || !index?.size) return undefined
    const read = (): void => {
      const next = [...new Set(linksOf(body).map((link) => Number(link.dataset.citationNumber)))]
      setNumbers((old) => old.length === next.length && old.every((number, i) => number === next[i]) ? old : next)
    }
    read()
    const observer = new MutationObserver(read)
    for (const reply of body.querySelectorAll('[data-citation-reply]')) {
      if (reply.closest('.v3-assistant-body') === body) observer.observe(reply, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-citation-number'] })
    }
    return () => observer.disconnect()
  }, [index])
  if (!index?.size) return null
  const sources = [...index.values()].filter(({ n }) => numbers.includes(n)).sort((a, b) => a.n - b.n)
  return (
    <div ref={slot} className="ws-reply-sources" hidden={!sources.length} data-testid="reply-sources">
      {sources.length ? (
        <Collapsible>
          <CollapsibleHeader size="compact" chevron="end" data-testid="reply-sources-toggle">{tt('replySources', { n: sources.length })}</CollapsibleHeader>
          <CollapsiblePanel>
            <ul className="ws-reply-sources-list">
              {sources.map(({ n, domain, title, url }) => (
                <li key={n} data-testid="reply-source">
                  <span className="ui-num">{n}</span>
                  <a href={url} onClick={(event) => { event.preventDefault(); void openLink(url) }}>
                    <span>{title || domain}</span>
                    <small>{domain}</small>
                  </a>
                  <Button size="xs" variant="ghost" aria-label={tt('backToCitation', { n })} onPress={() => {
                    const body = slot.current?.closest<HTMLElement>('.v3-assistant-body')
                    const link = body && linksOf(body).find((item) => Number(item.dataset.citationNumber) === n)
                    link?.focus({ preventScroll: true })
                    link?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                  }}>{tt('backToCitationShort')}</Button>
                </li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  )
}
