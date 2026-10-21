import { lazy, Suspense, type ReactElement } from 'react'
import type { CodeEditorProps } from './CodeEditor'

const LoadedCodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

export function CodeEditor(props: CodeEditorProps): ReactElement {
  return (
    <Suspense fallback={null}>
      <LoadedCodeEditor {...props} />
    </Suspense>
  )
}
