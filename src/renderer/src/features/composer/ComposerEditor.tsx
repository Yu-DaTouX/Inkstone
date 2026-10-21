import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { EditorState, Plugin, TextSelection as PmTextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import type { ComposerKeyEvent, ComposerPasteEvent } from './composer-keys'
import { afterFenceInsertTransaction, afterFencePlugin } from './after-fence'
import {
  atomInsertTransaction,
  caretInCode,
  codeBlockEnterTransaction,
  fenceTransaction,
  inputRuleTransaction,
  reconcileTextTransaction,
  selectAtomBefore,
  structureTransaction
} from './composer-edit'
import {
  caretSelection,
  clampSelection,
  docToText,
  positionForTextOffset,
  replaceTextRange,
  textOffsetForPosition,
  textToDoc,
  type ComposerAtomSpec,
  type ComposerDocumentOptions,
  type TextSelection
} from './composer-text'

export interface CaretRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface ComposerEditorChange {
  text: string
  cursor: number
}

export interface ComposerEditorHandle {
  focus: (options?: FocusOptions) => void
  getText: () => string
  getSelection: () => TextSelection
  setSelection: (selection: number | TextSelection) => void
  insertText: (text: string) => void
  insertAtom: (range: TextSelection, spec: ComposerAtomSpec, trailing?: string) => boolean
  replaceRange: (range: TextSelection, text: string) => void
  refreshStructure: () => void
  isComposing: () => boolean
  isEmpty: () => boolean
  caretInCode: () => boolean
  caretRect: () => CaretRect | null
}

interface ComposerEditorProps {
  value: string
  cursor: number | null
  placeholder: string
  ariaLabel: string
  expanded: boolean
  chipContext?: ComposerDocumentOptions
  activeOptionId?: string
  'data-testid'?: string
  onChange: (change: ComposerEditorChange) => void
  onCursorChange?: (cursor: number) => void
  onKeyDown?: (event: ComposerKeyEvent) => void
  onPaste?: (event: ComposerPasteEvent) => void
  onCompositionChange?: (composing: boolean) => void
}

const textSelectionOf = (view: EditorView): TextSelection => ({
  start: textOffsetForPosition(view.state.doc, view.state.selection.from),
  end: textOffsetForPosition(view.state.doc, view.state.selection.to)
})

const isComposingEvent = (view: EditorView, event: KeyboardEvent): boolean =>
  view.composing || event.isComposing || event.keyCode === 229

const composerKeyEvent = (event: KeyboardEvent): ComposerKeyEvent => ({
  key: event.key,
  shiftKey: event.shiftKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  altKey: event.altKey,
  get defaultPrevented(): boolean {
    return event.defaultPrevented
  },
  nativeEvent: event,
  preventDefault: () => event.preventDefault()
})

const focusSoon = (view: EditorView | null): void => {
  if (!view) return
  requestAnimationFrame(() => view.focus())
}

function insertHardBreak(view: EditorView): void {
  const { state } = view
  const tr = state.selection.empty ? state.tr : state.tr.deleteSelection()
  const at = tr.selection.from
  tr.insert(at, state.schema.nodes.hard_break.create())
  tr.setSelection(PmTextSelection.near(tr.doc.resolve(at + 1), 1)).scrollIntoView()
  view.dispatch(tr)
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(
  props,
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const composingRef = useRef(false)
  const pendingValue = useRef<string | null>(null)
  const appliedCursor = useRef<number | null>(null)
  const ignoreCursorOnce = useRef(false)
  const emittedMentions = useRef(new Set<string>())

  const documentOptions = useCallback((): ComposerDocumentOptions => {
    const context = propsRef.current.chipContext ?? {}
    const mentions = new Set(context.mentions ?? [])
    for (const path of emittedMentions.current) mentions.add(path)
    return {
      commands: context.commands ?? [],
      mentions: [...mentions],
      imagePrefix: context.imagePrefix,
      imageCount: context.imageCount ?? 0
    }
  }, [])

  const currentText = useCallback((): string => {
    const view = viewRef.current
    return view ? docToText(view.state.doc) : propsRef.current.value
  }, [])

  const markEmpty = useCallback((): void => {
    const host = hostRef.current
    if (host) host.dataset.empty = currentText() ? 'false' : 'true'
  }, [currentText])

  const refreshStructure = useCallback((): void => {
    const view = viewRef.current
    if (!view) return
    const tr = structureTransaction(view.state, documentOptions())
    if (!tr) return
    tr.setMeta('addToHistory', false)
    view.dispatch(tr)
  }, [documentOptions])

  const applyDocumentText = useCallback(
    (nextText: string, cursor: number, keepHistory: boolean): void => {
      const view = viewRef.current
      if (!view) return
      const tr = reconcileTextTransaction(view.state, nextText, documentOptions())
      if (!tr) return
      if (!keepHistory) tr.setMeta('addToHistory', false)
      const at = positionForTextOffset(tr.doc, Math.max(0, Math.min(cursor, nextText.length)))
      tr.setSelection(PmTextSelection.create(tr.doc, at)).scrollIntoView()
      view.dispatch(tr)
      refreshStructure()
    },
    [documentOptions, refreshStructure]
  )

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const plugins = () => [
      history(),
      keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo }),
      keymap({ Backspace: selectAtomBefore }),
      keymap(baseKeymap),
      afterFencePlugin(),
      new Plugin({
        appendTransaction(transactions, _previous, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          const current = viewRef.current
          if (!current || current.composing || composingRef.current) return null
          return fenceTransaction(state, documentOptions())
        }
      })
    ]
    const view: EditorView = new EditorView({ mount: host }, {
      state: EditorState.create({ doc: textToDoc(propsRef.current.value, documentOptions()), plugins: plugins() }),
      attributes: () => ({ class: 'composer-text' }),
      dispatchTransaction(transaction) {
        const current = viewRef.current
        if (!current) return
        const state = current.state.apply(transaction)
        current.updateState(state)
        if (transaction.docChanged) {
          markEmpty()
          const cursor = textOffsetForPosition(state.doc, state.selection.from)
          appliedCursor.current = cursor
          propsRef.current.onChange({ text: docToText(state.doc), cursor })
          return
        }
        if (!transaction.selectionSet) return
        const cursor = textOffsetForPosition(state.doc, state.selection.from)
        if (cursor === appliedCursor.current) return
        appliedCursor.current = cursor
        propsRef.current.onCursorChange?.(cursor)
      },
      handleTextInput(current, from, to, text) {
        if (current.composing || composingRef.current) return false
        const afterFence = from === to ? afterFenceInsertTransaction(current.state, text) : null
        if (afterFence) {
          current.dispatch(afterFence)
          return true
        }
        const tr = inputRuleTransaction(current.state, from, to, text)
        if (!tr) return false
        current.dispatch(tr)
        return true
      },
      handleDOMEvents: {
        keydown(current, event) {
          if (isComposingEvent(current, event)) return false
          propsRef.current.onKeyDown?.(composerKeyEvent(event))
          if (event.defaultPrevented) return true
          if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return false
          event.preventDefault()
          const afterFence = afterFenceInsertTransaction(current.state, '')
          if (afterFence) {
            current.dispatch(afterFence)
            return true
          }
          const codeBlock = codeBlockEnterTransaction(current.state)
          if (codeBlock) {
            current.dispatch(codeBlock)
            return true
          }
          insertHardBreak(current)
          return true
        },
        compositionstart() {
          composingRef.current = true
          propsRef.current.onCompositionChange?.(true)
        },
        compositionend() {
          composingRef.current = false
          propsRef.current.onCompositionChange?.(false)
          queueMicrotask(() => {
            queueMicrotask(() => {
              const pending = pendingValue.current
              pendingValue.current = null
              const current = viewRef.current
              if (pending === null || !current || current.composing) return
              if (pending === docToText(current.state.doc)) return
              applyDocumentText(pending, pending.length, false)
            })
          })
        },
        blur() {
          composingRef.current = false
        }
      },
      handlePaste(current, event) {
        const data = event.clipboardData
        if (!data) return false
        propsRef.current.onPaste?.({ clipboardData: data, preventDefault: () => event.preventDefault() })
        if (event.defaultPrevented) return true
        const text = data.getData('text/plain')
        if (!text) return false
        event.preventDefault()
        const normalized = text.replace(/\r\n?/g, '\n')
        if (!normalized.includes('\n')) {
          current.dispatch(current.state.tr.insertText(normalized).scrollIntoView())
          return true
        }
        const selection = textSelectionOf(current)
        const next = replaceTextRange(docToText(current.state.doc), selection, normalized)
        applyDocumentText(next.text, next.cursor, true)
        return true
      }
    })
    viewRef.current = view
    markEmpty()
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = props.value
    if (next === docToText(view.state.doc)) return
    if (view.composing || composingRef.current) {
      pendingValue.current = next
      return
    }
    ignoreCursorOnce.current = true
    applyDocumentText(next, next.length, false)
  }, [props.value, applyDocumentText])

  useLayoutEffect(() => {
    refreshStructure()
  }, [props.chipContext, refreshStructure])

  useLayoutEffect(() => {
    const view = viewRef.current
    const target = props.cursor
    if (!view || target === null) return
    if (ignoreCursorOnce.current) {
      ignoreCursorOnce.current = false
      return
    }
    if (view.composing || composingRef.current) return
    if (appliedCursor.current === target) return
    if (!view.hasFocus()) return
    const current = textOffsetForPosition(view.state.doc, view.state.selection.from)
    appliedCursor.current = target
    if (current === target) return
    const at = positionForTextOffset(view.state.doc, target)
    view.dispatch(
      view.state.tr.setSelection(PmTextSelection.create(view.state.doc, at)).setMeta('addToHistory', false)
    )
  }, [props.cursor])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        viewRef.current?.focus()
      },
      getText: () => currentText(),
      getSelection: () => {
        const view = viewRef.current
        if (!view) return caretSelection(propsRef.current.value, appliedCursor.current ?? propsRef.current.value.length)
        return textSelectionOf(view)
      },
      setSelection: (selection) => {
        const view = viewRef.current
        if (!view) return
        const { doc } = view.state
        const text = docToText(doc)
        const next = typeof selection === 'number' ? caretSelection(text, selection) : clampSelection(text, selection)
        view.dispatch(
          view.state.tr
            .setSelection(
              PmTextSelection.create(
                doc,
                positionForTextOffset(doc, next.start),
                positionForTextOffset(doc, next.end)
              )
            )
            .setMeta('addToHistory', false)
            .scrollIntoView()
        )
      },
      insertText: (text) => {
        const view = viewRef.current
        if (!view) return
        const next = replaceTextRange(docToText(view.state.doc), textSelectionOf(view), text)
        applyDocumentText(next.text, next.cursor, true)
        focusSoon(viewRef.current)
      },
      insertAtom: (range, spec, trailing = '') => {
        const view = viewRef.current
        if (!view) return false
        const tr = atomInsertTransaction(view.state, range, spec, trailing)
        if (!tr) return false
        if (spec.kind === 'mention' && spec.path) emittedMentions.current.add(spec.path)
        view.dispatch(tr)
        focusSoon(viewRef.current)
        return true
      },
      replaceRange: (range, text) => {
        const view = viewRef.current
        if (!view) return
        const next = replaceTextRange(docToText(view.state.doc), range, text)
        applyDocumentText(next.text, next.cursor, true)
        focusSoon(viewRef.current)
      },
      refreshStructure,
      isComposing: () => composingRef.current || !!viewRef.current?.composing,
      isEmpty: () => hostRef.current?.dataset.empty !== 'false',
      caretInCode: () => {
        const view = viewRef.current
        return view ? caretInCode(view.state) : false
      },
      caretRect: () => {
        const view = viewRef.current
        if (!view) return null
        const coords = view.coordsAtPos(view.state.selection.from)
        if (!coords) return null
        return {
          left: coords.left,
          top: coords.top,
          right: coords.right,
          bottom: coords.bottom,
          width: coords.right - coords.left,
          height: coords.bottom - coords.top
        }
      }
    }),
    [applyDocumentText, currentText, refreshStructure]
  )

  return (
    <div
      ref={hostRef}
      className="composer-text"
      role="textbox"
      aria-multiline="true"
      aria-label={props.ariaLabel}
      aria-autocomplete="list"
      aria-expanded={props.expanded}
      aria-activedescendant={props.activeOptionId}
      data-testid={props['data-testid']}
      data-placeholder={props.placeholder}
      data-placeholder-visible={props.value === '' || props.value === '!' ? 'true' : 'false'}
      data-empty="true"
      spellCheck={false}
      contentEditable
      suppressContentEditableWarning
    />
  )
})
