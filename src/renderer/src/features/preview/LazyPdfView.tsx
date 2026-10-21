import { lazy, Suspense, type ComponentProps, type ReactElement } from 'react'
import type { PdfView as PdfViewComponent } from './PdfView'

const LoadedPdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })))

export function PdfView(props: ComponentProps<typeof PdfViewComponent>): ReactElement {
  return (
    <Suspense fallback={null}>
      <LoadedPdfView {...props} />
    </Suspense>
  )
}
