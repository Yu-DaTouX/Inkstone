import type { ReactElement } from 'react'
import { useCapsText } from './text'
import { PackagesPanel } from './PackagesPanel'

export function ExtensionsSection(): ReactElement {
  const text = useCapsText()
  return <PackagesPanel showBuiltin note={text('extensionsPackagesNote')} />
}
