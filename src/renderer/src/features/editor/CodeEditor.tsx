import { useEffect, useRef, type ReactElement } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, foldService, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { editorLanguage } from './editor-language'
import { DEFAULT_FILE_VIEW_SETTINGS, type FileViewSettings } from '../preview/file-view-settings'
import { leadingColumns } from '../preview/code-lines'
import './editor.css'

const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--syn-punct)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName, tags.heading], color: 'var(--syn-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syn-attr)' },
  { tag: [tags.tagName, tags.variableName], color: 'var(--syn-variable)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--syn-meta)' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [tags.invalid], color: 'var(--fail)' }
])

const indentFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const tabSize = state.tabSize
  const indent = leadingColumns(line.text, tabSize)
  if (indent === null) return null
  let end = -1
  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const next = state.doc.line(number)
    const value = leadingColumns(next.text, tabSize)
    if (value === null) continue
    if (value <= indent) break
    end = next.to
  }
  return end > line.to ? { from: line.to, to: end } : null
})

function viewOptions(settings: FileViewSettings, readOnly: boolean): Extension[] {
  return [
    settings.wordWrap ? EditorView.lineWrapping : [],
    EditorState.tabSize.of(settings.tabSize),
    settings.showWhitespace ? highlightWhitespace() : [],
    settings.scrollPastEnd ? scrollPastEnd() : [],
    EditorView.editable.of(!readOnly),
    EditorState.readOnly.of(readOnly)
  ]
}

const THEME = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: 'var(--t-code)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--t-code-lh)',
    overflow: 'auto'
  },
  '.cm-content': { padding: 'var(--s-4) 0' },
  '.cm-line': { padding: '0 1ch 0 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg3)',
    border: 'none'
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', padding: '0 0 0 calc(2ch + 5px)', fontVariantNumeric: 'tabular-nums' },
  '.cm-foldGutter .cm-gutterElement': { width: '2ch', display: 'flex', justifyContent: 'center', color: 'var(--fg3)', cursor: 'pointer' },
  '.cm-foldPlaceholder': { margin: '0 1ch', padding: '0 var(--s-4)', border: 'none', borderRadius: 'var(--r-xs)', backgroundColor: 'var(--alpha-2)', color: 'var(--fg3)' },
  '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--fg3) 1px, transparent 1.25px)', opacity: '0.6' },
  '.cm-highlightTab': { opacity: '0.6' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--fg) 8%, transparent)', color: 'var(--fg2)' },
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
  settings?: FileViewSettings
  onChange: (value: string) => void
  onSave: () => void
}

export function CodeEditor({ value, name, readOnly, settings = DEFAULT_FILE_VIEW_SETTINGS, onChange, onSave }: CodeEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageRef = useRef(new Compartment())
  const optionsRef = useRef(new Compartment())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const readOnlyRef = useRef(readOnly === true)
  readOnlyRef.current = readOnly === true
  const nameRef = useRef(name)
  nameRef.current = name
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter({ openText: '⌄', closedText: '›' }),
      indentFolding,
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
      languageRef.current.of(editorLanguage(nameRef.current)),
      optionsRef.current.of(viewOptions(settingsRef.current, readOnlyRef.current)),
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
        ...foldKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
      THEME
    ]
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

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
    viewRef.current?.dispatch({ effects: optionsRef.current.reconfigure(viewOptions(settings, readOnly === true)) })
  }, [settings, readOnly])

  useEffect(() => {
    if (readOnly) return
    viewRef.current?.focus()
  }, [readOnly])

  return <div className="v3-editor" ref={hostRef} data-testid="v3-editor" />
}
