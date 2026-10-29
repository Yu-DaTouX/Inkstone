import type { ReactElement } from 'react'
import { Collapsible, CollapsibleHeader, CollapsiblePanel } from '../../ui'
import { ChangePathLabel, ChangeStatusMark } from './ChangeEntryLabel'
import type { ChangeItem } from './types'
import type { ChangesText } from './text'

export interface ChangesBinaryGroupProps {
  items: readonly ChangeItem[]
  expanded: boolean
  onToggle: () => void
  lang?: string
  text: ChangesText
  dirs?: ReadonlyMap<string, string>
}

export function ChangesBinaryGroup({ items, expanded, onToggle, lang, text, dirs }: ChangesBinaryGroupProps): ReactElement {
  return (
    <section className="changes-file changes-binary" data-testid="changes-binary-group" data-collapsed={expanded ? undefined : ''}>
      <Collapsible isExpanded={expanded} onExpandedChange={onToggle}>
        <CollapsibleHeader className="changes-file__head" tone="emphasized" rowHover>
          {text.binaryGroup(items.length)}
        </CollapsibleHeader>
        <CollapsiblePanel className="changes-file__body">
          {expanded ? (
            <ul className="changes-binary__list">
              {items.map((item) => (
                <li key={item.path} className="changes-binary__row" data-path={item.path}>
                  <ChangePathLabel path={item.path} dir={dirs?.get(item.path) ?? ''} mark={<ChangeStatusMark item={item} lang={lang} text={text} />} />
                </li>
              ))}
            </ul>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </section>
  )
}
