import type { Node as ProseNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const ULTRACODE_COMMAND = /^\s*(\/ultracode)(?=$|\s)/i

function keywordDecorations(doc: ProseNode): DecorationSet {
  const first = doc.firstChild
  if (!first?.isTextblock) return DecorationSet.empty
  const head = first.firstChild
  if (!head?.isText || !head.text) return DecorationSet.empty
  const match = ULTRACODE_COMMAND.exec(head.text)
  if (!match) return DecorationSet.empty
  const from = 1 + match.index + match[0].length - match[1].length
  return DecorationSet.create(doc, [Decoration.inline(from, from + match[1].length, { class: 'composer-ultracode' })])
}

const ultracodeKey = new PluginKey<DecorationSet>('composer-ultracode')

export function ultracodeKeywordPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: ultracodeKey,
    state: {
      init: (_config, state) => keywordDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? keywordDecorations(tr.doc) : value)
    },
    props: {
      decorations: (state) => ultracodeKey.getState(state)
    }
  })
}
