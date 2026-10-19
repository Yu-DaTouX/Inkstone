import { useEffect, useRef, type ReactElement } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { editorLanguage } from './editor-language'
import './editor.css'

const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.operator, tags.modifier, tags.controlKeyword, tags.definitionKeyword], color: 'var(--accent)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--ask)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--fg3)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: 'var(--stall)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--fg)', fontWeight: '600' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--fg2)' },
  { tag: [tags.tagName, tags.heading], color: 'var(--accent)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [tags.invalid], color: 'var(--fail)' }
])

const THEME = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: 'var(--t-footnote)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    overflow: 'auto'
  },
  '.cm-content': { padding: 'var(--s-4) 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg3)',
    border: 'none'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--s-6) 0 var(--s-8)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover-main)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover-main)', color: 'var(--fg2)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)'
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--sel)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--sel)',
    outline: '1px solid var(--line2)'
  }
})

export interface CodeEditorProps {
  value: string
  name: string
  readOnly?: boolean
  onChange: (value: string) => void
  onSave: () => void
}

export function CodeEditor({ value, name, readOnly, onChange, onSave }: CodeEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageRef = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      syntaxHighlighting(HIGHLIGHT),
      languageRef.current.of(editorLanguage(name)),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current()
            return true
          }
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
      EditorView.editable.of(readOnly !== true),
      EditorState.readOnly.of(readOnly === true),
      THEME
    ]
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [name, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: languageRef.current.reconfigure(editorLanguage(name)) })
  }, [name])

  useEffect(() => {
    if (readOnly) return
    viewRef.current?.focus()
  }, [readOnly])

  return <div className="v3-editor" ref={hostRef} data-testid="v3-editor" />
}
