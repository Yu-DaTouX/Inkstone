import { type Node as ProseNode } from 'prosemirror-model'
import { NodeSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import {
  isAtomNode,
  atomNode,
  composerSchema,
  docToText,
  positionForTextOffset,
  replaceTextRange,
  textOffsetForPosition,
  textToDoc,
  trimUrlTail,
  type ComposerAtomSpec,
  type ComposerDocumentOptions,
  type TextSelection as TextRange
} from './composer-text'

import { afterFenceKey, fenceTailPosition } from './after-fence'

const OBJECT = '\uFFFC'
const LINK_TARGET = /^(?:https?:\/\/|mailto:|tel:)[\w\-.~:/?#[\]@!$&'*+,;=%{}|^()]+$/i
const BARE_URL = /(?:^|[\s(])((?:https?:\/\/|mailto:)[^\s<>"]+)$/i
const INLINE_CODE = /(?<=^|[^`])(`[^`\n]+`)(?!`)$/
const STRIKE = /(?:^|\s)(~~(?!\s+~~)[^~\n]+~~(?!\s+~~))$/

export function linkTargetValid(href: string): boolean {
  if (!LINK_TARGET.test(href)) return false
  const open = (href.match(/\(/g) ?? []).length
  const close = (href.match(/\)/g) ?? []).length
  return open === close
}

export function countStructure(doc: ProseNode): { atoms: number; code: number } {
  let atoms = 0
  let code = 0
  doc.descendants((node) => {
    if (isAtomNode(node)) atoms += 1
    if (node.type.name === 'code_block') code += 1
    return true
  })
  return { atoms, code }
}

function rangeHasAtom(doc: ProseNode, from: number, to: number): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    if (found) return false
    if (isAtomNode(node)) found = true
    return !found
  })
  return found
}

function lineBefore(state: EditorState, pos: number): string {
  const $pos = state.doc.resolve(pos)
  const whole = $pos.parent.textBetween(0, $pos.parentOffset, undefined, (node) =>
    node.type.name === 'hard_break' ? '\n' : OBJECT
  )
  return whole.slice(whole.lastIndexOf('\n') + 1)
}

export function caretInCode(state: EditorState): boolean {
  const { $from } = state.selection
  if ($from.parent.type.spec.code === true) return true
  return (state.storedMarks ?? $from.marks()).some((mark) => mark.type.spec.code === true)
}

function codeMarkInRange(state: EditorState, from: number, to: number): boolean {
  return from < to && state.doc.rangeHasMark(from, to, composerSchema.marks.code)
}

export function atomInsertTransaction(
  state: EditorState,
  range: TextRange,
  spec: ComposerAtomSpec,
  trailing = ''
): Transaction | null {
  const { doc } = state
  const inserted = `${spec.raw}${trailing}`
  const expected = replaceTextRange(docToText(doc), range, inserted)
  const from = positionForTextOffset(doc, range.start, 1)
  const to = Math.max(from, positionForTextOffset(doc, range.end, -1))
  const content = [atomNode(spec), ...(trailing ? [composerSchema.text(trailing)] : [])]
  const tr = state.tr.replaceWith(from, to, content)
  if (docToText(tr.doc) !== expected.text) return null
  const at = positionForTextOffset(tr.doc, expected.cursor)
  return tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView()
}

export function selectAtomBefore(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection
  if (!empty) return false
  const before = $from.nodeBefore
  if (!before || !isAtomNode(before)) return false
  if (dispatch) {
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, $from.pos - before.nodeSize)))
  }
  return true
}

export function reconcileTextTransaction(
  state: EditorState,
  nextText: string,
  options: ComposerDocumentOptions = {}
): Transaction | null {
  const old = docToText(state.doc)
  if (old === nextText) return null
  let head = 0
  let tail = 0
  while (head < old.length && head < nextText.length && old[head] === nextText[head]) head += 1
  while (
    tail < old.length - head &&
    tail < nextText.length - head &&
    old[old.length - 1 - tail] === nextText[nextText.length - 1 - tail]
  ) {
    tail += 1
  }
  const from = positionForTextOffset(state.doc, head, -1)
  const to = positionForTextOffset(state.doc, old.length - tail, 1)
  const actualStart = textOffsetForPosition(state.doc, from)
  const actualEnd = textOffsetForPosition(state.doc, to)
  const suffix = Math.max(0, old.length - actualEnd)
  const end = Math.max(actualStart, nextText.length - suffix)
  if (!rangeHasAtom(state.doc, from, to)) {
    const tr = state.tr.insertText(nextText.slice(actualStart, end), from, to)
    if (docToText(tr.doc) === nextText) return tr
  }
  const doc = textToDoc(nextText, options)
  return state.tr.replaceWith(0, state.doc.content.size, doc.content)
}

export function structureTransaction(state: EditorState, options: ComposerDocumentOptions = {}): Transaction | null {
  const text = docToText(state.doc)
  const target = textToDoc(text, options)
  if (docToText(target) !== text) return null
  const before = countStructure(state.doc)
  const after = countStructure(target)
  if (after.code < before.code) return null
  if (after.code === before.code && after.atoms <= before.atoms) return null
  const doc = target
  if (state.doc.eq(doc)) return null
  const cursor = textOffsetForPosition(state.doc, state.selection.from)
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content)
  const at = positionForTextOffset(tr.doc, cursor)
  tr.setSelection(TextSelection.create(tr.doc, at))
  return tr.setMeta(afterFenceKey, fenceTailPosition(tr.doc, cursor))
}

export function fenceTransaction(state: EditorState, options: ComposerDocumentOptions = {}): Transaction | null {
  if (countStructure(state.doc).code > 0) return null
  if (!docToText(state.doc).includes('```')) return null
  const tr = structureTransaction(state, options)
  if (!tr) return null
  return countStructure(tr.doc).code > 0 ? tr : null
}

function autolinkTransaction(state: EditorState, pos: number): Transaction | null {
  const $pos = state.doc.resolve(pos)
  if ($pos.parent.type.spec.code === true) return null
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, (node) =>
    node.type.name === 'hard_break' ? '\n' : OBJECT
  )
  const match = BARE_URL.exec(before)
  if (!match) return null
  const url = trimUrlTail(match[1])
  if (!url || !linkTargetValid(url)) return null
  const start = pos - (before.length - (match.index + match[0].length - match[1].length))
  const end = start + url.length
  if (state.doc.rangeHasMark(start, end, composerSchema.marks.link)) return null
  if (codeMarkInRange(state, start, end)) return null
  const tr = state.tr.addMark(start, end, composerSchema.marks.link.create({ href: url })).insertText(' ', pos)
  return docToText(tr.doc) === `${docToText(state.doc)} ` ? tr : null
}

export function inlineCodeTransaction(state: EditorState, from: number): Transaction | null {
  const before = lineBefore(state, from)
  const match = INLINE_CODE.exec(`${before}\``)
  if (!match || match[0].length > 120 || match[0].includes(OBJECT)) return null
  const start = from - (match[0].length - 1)
  const end = from - 1
  if (end <= start) return null
  if (codeMarkInRange(state, start, end)) return null
  const tr = state.tr.delete(start, start + 1)
  tr.addMark(start, end, composerSchema.marks.code.create())
  tr.setStoredMarks([])
  return docToText(tr.doc) === `${docToText(state.doc)}\`` ? tr : null
}

export function strikeTransaction(state: EditorState, from: number): Transaction | null {
  const before = lineBefore(state, from)
  const match = STRIKE.exec(`${before}~`)
  if (!match || match[0].includes(OBJECT)) return null
  const full = match[0]
  const lead = full.search(/\S/)
  const inner = full.slice(full.indexOf('~~') + 2, full.lastIndexOf('~~'))
  if (!inner) return null
  const begin = from - (full.length - 1)
  const textStart = begin + full.indexOf(inner)
  const textEnd = textStart + inner.length
  if (textStart < begin || textEnd > from) return null
  if (codeMarkInRange(state, textStart, textEnd)) return null
  const tr = state.tr.delete(textEnd, from).delete(begin + lead, textStart)
  const markStart = begin + lead
  tr.addMark(markStart, markStart + inner.length, composerSchema.marks.strike.create())
  tr.removeStoredMark(composerSchema.marks.strike)
  return docToText(tr.doc) === `${docToText(state.doc)}~` ? tr : null
}

export function inputRuleTransaction(
  state: EditorState,
  from: number,
  to: number,
  text: string
): Transaction | null {
  if (from !== to || !text) return null
  if (caretInCode(state)) return null
  if (text === '`') return inlineCodeTransaction(state, from)
  if (text === '~') return strikeTransaction(state, from)
  if (text === ' ' && state.selection.$from.parent.type.name === 'paragraph') {
    return autolinkTransaction(state, from)
  }
  return null
}

export function codeBlockEnterTransaction(state: EditorState): Transaction | null {
  const { $from } = state.selection
  if ($from.parent.type.name !== 'code_block') return null
  const content = $from.parent.textContent
  const atEnd = $from.parentOffset === $from.parent.content.size
  if (atEnd && (content === '' || content.endsWith('\n'))) {
    const after = $from.after()
    const tr = state.tr.insert(after, composerSchema.node('paragraph', null, []))
    return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView()
  }
  const whole = docToText(state.doc)
  const caret = textOffsetForPosition(state.doc, $from.pos)
  const expected = `${whole.slice(0, caret)}\n${whole.slice(caret)}`
  const tr = state.tr.insertText('\n', $from.pos)
  return docToText(tr.doc) === expected ? tr.scrollIntoView() : null
}
