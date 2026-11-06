import { lazy, Suspense, type ReactElement } from 'react'
import type { DiffViewProps } from './DiffView'

const LoadedDiffView = lazy(() => import('./DiffView').then((m) => ({ default: m.DiffView })))

export function DiffView(props: DiffViewProps): ReactElement {
  return (
    <Suspense fallback={null}>
      <LoadedDiffView {...props} />
    </Suspense>
  )
}
