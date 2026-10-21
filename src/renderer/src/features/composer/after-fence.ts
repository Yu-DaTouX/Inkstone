import type { Node as ProseNode } from 'prosemirror-model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { composerSchema, composerTextRuns, docToText } from './composer-text'

export const afterFenceKey = new PluginKey<number | null>('composer-after-fence')

export function fenceTailPosition(doc: ProseNode, cursorOffset: number): number | null {
  let consumed = 0
  for (const run of composerTextRuns(doc)) {
    const end = consumed + run.value.length
    if (run.fenced) {
      const contentEnd = end - run.post
      if (cursorOffset > contentEnd && cursorOffset <= end) {
        const after = doc.resolve(run.to).after()
        return after
      }
    }
    consumed = end
  }
  return null
}

export function afterFencePosition(state: EditorState): number | null {
  return afterFenceKey.getState(state) ?? null
}

function textBreakAt(doc: ProseNode, pos: number): number {
  let consumed = 0
  for (const run of composerTextRuns(doc)) {
    if (run.fenced && doc.resolve(run.to).after() === pos) return consumed + run.value.length
    consumed += run.value.length
  }
  return consumed
}

export function afterFenceInsertTransaction(state: EditorState, text: string): Transaction | null {
  const pos = afterFencePosition(state)
  if (pos === null) return null
  const before = docToText(state.doc)
  const at = textBreakAt(state.doc, pos)
  const paragraph = composerSchema.node('paragraph', null, text ? [composerSchema.text(text)] : [])
  const tr = state.tr.insert(pos, paragraph)
  tr.setSelection(TextSelection.create(tr.doc, pos + 1 + text.length))
  const expected = `${before.slice(0, at)}\n${text}${before.slice(at)}`
  return docToText(tr.doc) === expected ? tr.scrollIntoView() : null
}

export function afterFencePlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: afterFenceKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(afterFenceKey) as number | null | undefined
        if (meta !== undefined) return meta
        if (value === null) return null
        if (tr.docChanged || tr.selectionSet) return null
        return value
      }
    },
    props: {
      attributes(state): Record<string, string> {
        return afterFencePosition(state) === null ? {} : { 'data-after-fence': '' }
      },
      decorations(state) {
        const pos = afterFencePosition(state)
        if (pos === null) return null
        const widget = (): HTMLElement => {
          const line = document.createElement('div')
          line.className = 'composer-fence-caret'
          line.setAttribute('aria-hidden', 'true')
          return line
        }
        return DecorationSet.create(state.doc, [Decoration.widget(pos, widget, { side: 1, key: `after-fence-${pos}` })])
      }
    }
  })
}
