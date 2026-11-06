import { Suspense, type ReactElement } from 'react'
import { preloadable } from '../../lib/preloadable'
import type { CodeEditorProps } from './CodeEditor'

const loadedEditor = preloadable<CodeEditorProps>(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))
const LoadedCodeEditor = loadedEditor.Component

export const preloadCodeEditor = loadedEditor.preload

export function CodeEditor(props: CodeEditorProps): ReactElement {
  return (
    <Suspense fallback={null}>
      <LoadedCodeEditor {...props} />
    </Suspense>
  )
}
