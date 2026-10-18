import type { ReactElement } from 'react'
import { useCapsText } from './text'
import { PackagesPanel } from './PackagesPanel'
import { Panel } from './parts'

export function ExtensionsSection(): ReactElement {
  const text = useCapsText()
  return (
    <Panel label={text('extensions')}>
      <PackagesPanel mode="installed" />
    </Panel>
  )
}
