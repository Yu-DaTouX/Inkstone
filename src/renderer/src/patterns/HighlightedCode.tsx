import { Fragment, useMemo, type JSX } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { highlightLanguage, highlightTree } from '../lib/code-highlight'
import './highlighted-code.css'

export function HighlightedCode({ code, lang, className }: { code: string; lang?: string | null; className?: string }): JSX.Element {
  const tree = useMemo(() => highlightTree(code, lang), [code, lang])
  const known = highlightLanguage(lang)
  const classes = ['hljs', known ? `language-${known}` : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <code className={classes} data-highlight={tree ? 'on' : 'plain'}>
      {tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : code}
    </code>
  )
}
