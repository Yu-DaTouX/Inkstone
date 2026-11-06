import { Suspense, type ComponentProps, type ReactElement } from 'react'
import { preloadable } from '../../lib/preloadable'
import type { PdfView as PdfViewComponent } from './PdfView'

const loadedPdf = preloadable<ComponentProps<typeof PdfViewComponent>>(() => import('./PdfView').then((m) => ({ default: m.PdfView })))
const LoadedPdfView = loadedPdf.Component

export const preloadPdfView = loadedPdf.preload

export function PdfView(props: ComponentProps<typeof PdfViewComponent>): ReactElement {
  return (
    <Suspense fallback={null}>
      <LoadedPdfView {...props} />
    </Suspense>
  )
}
