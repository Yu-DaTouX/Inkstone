import { memo, useMemo, type ReactElement } from 'react'
import { highlightLanguage } from '../../lib/code-highlight'
import { HighlightedCode as SharedHighlightedCode } from '../../patterns/HighlightedCode'
import { pickLanguage } from './preview-language'

export const HighlightedCode = memo(function PreviewHighlightedCode({ code, name }: { code: string; name: string }): ReactElement {
  const language = useMemo(() => pickLanguage(name, (value) => highlightLanguage(value) !== null), [name])
  return <SharedHighlightedCode code={code} lang={language} />
})
