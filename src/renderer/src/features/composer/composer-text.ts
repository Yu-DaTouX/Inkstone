import { Schema, type Mark, type Node as ProseNode } from 'prosemirror-model'

export interface TextSelection {
  start: number
  end: number
}

export type ImageRefPrefix = '图' | 'img'

export interface ComposerAtomSpec {
  kind: 'command' | 'mention' | 'image'
  raw: string
  path?: string
  label?: string
}

export interface ComposerDocumentOptions {
  commands?: string[]
  mentions?: string[]
  imagePrefix?: ImageRefPrefix
  imageCount?: number
}

export const ATOM_NODE_NAMES: readonly string[] = ['command_chip', 'mention']

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      whitespace: 'pre',
      toDOM: () => ['p', 0] as const,
      parseDOM: [{ tag: 'p' }]
    },
    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      whitespace: 'pre',
      attrs: { language: { default: '' } },
      toDOM: (node) => ['pre', { class: 'composer-code', 'data-language': node.attrs.language }, ['code', 0]] as const,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' as const }]
    },
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br'] as const,
      parseDOM: [{ tag: 'br' }],
      leafText: () => '\n'
    },
    command_chip: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: { id: {} },
      toDOM: (node) => [
        'span',
        { class: 'composer-chip', 'data-command-chip': node.attrs.id, dir: 'auto' },
        `/${node.attrs.id}`
      ] as const,
      leafText: (node) => `/${node.attrs.id}`
    },
    mention: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: { raw: {}, path: { default: '' }, label: { default: '' }, kind: { default: 'file' } },
      toDOM: (node) => [
        'span',
        { class: 'composer-chip', 'data-mention': node.attrs.path, 'data-kind': node.attrs.kind, dir: 'auto' },
        String(node.attrs.raw)
      ] as const,
      leafText: (node) => String(node.attrs.raw)
    }
  },
  marks: {
    link: {
      attrs: { href: {} },
      inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href, rel: 'noopener noreferrer nofollow' }, 0] as const,
      parseDOM: [{ tag: 'a[href]' }]
    },
    strike: {
      toDOM: () => ['s', 0] as const,
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }]
    },
    code: {
      excludes: '_',
      inclusive: false,
      code: true,
      toDOM: () => ['code', { class: 'composer-inline-code' }, 0] as const,
      parseDOM: [{ tag: 'code' }]
    }
  }
})

export function atomRawText(node: ProseNode): string {
  if (node.type.name === 'command_chip') return `/${node.attrs.id}`
  if (node.type.name === 'mention') return String(node.attrs.raw)
  if (node.type.name === 'hard_break') return '\n'
  return ''
}

export function isAtomNode(node: ProseNode | null | undefined): boolean {
  return !!node && ATOM_NODE_NAMES.includes(node.type.name)
}

export function mentionLabelFor(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? String(path ?? '')
}

export function commandChipNode(id: string): ProseNode {
  return composerSchema.nodes.command_chip.create({ id })
}

export function mentionAtomNode(spec: ComposerAtomSpec): ProseNode {
  return composerSchema.nodes.mention.create({
    raw: spec.raw,
    path: spec.path ?? spec.raw.replace(/^@/, '').replace(/^["']|["']$/g, ''),
    label: spec.label ?? mentionLabelFor(spec.path ?? ''),
    kind: spec.kind === 'image' ? 'image' : 'file'
  })
}

export function atomNode(spec: ComposerAtomSpec): ProseNode {
  return spec.kind === 'command' ? commandChipNode(spec.path ?? spec.raw.replace(/^\//, '')) : mentionAtomNode(spec)
}

function markWrap(marks: readonly Mark[], text: string): { value: string; pre: number; post: number } {
  let inner = text
  let pre = 0
  let post = 0
  if (marks.some((mark) => mark.type.name === 'code')) {
    inner = `\`${inner}\``
    pre += 1
    post += 1
  }
  if (marks.some((mark) => mark.type.name === 'strike')) {
    inner = `~~${inner}~~`
    pre += 2
    post += 2
  }
  return { value: inner, pre, post }
}

export interface ComposerTextRun {
  from: number
  to: number
  value: string
  text: boolean
  pre: number
  post: number
  fenced?: boolean
}

export function composerTextRuns(doc: ProseNode): ComposerTextRun[] {
  const runs: ComposerTextRun[] = []
  doc.forEach((block, start, index) => {
    if (index) runs.push({ from: start - 1, to: start + 1, value: '\n', text: false, pre: 0, post: 0 })
    if (block.type.name === 'code_block') {
      const open = `\`\`\`${String(block.attrs.language ?? '')}\n`
      const close = '\n```'
      runs.push({
        from: start + 1,
        to: start + 1 + block.content.size,
        value: `${open}${block.textContent}${close}`,
        text: true,
        pre: open.length,
        post: close.length,
        fenced: true
      })
      return
    }
    block.forEach((node, offset) => {
      const from = start + 1 + offset
      if (node.isText) {
        const wrapped = markWrap(node.marks, node.text ?? '')
        runs.push({ from, to: from + node.nodeSize, value: wrapped.value, text: true, pre: wrapped.pre, post: wrapped.post })
        return
      }
      runs.push({ from, to: from + node.nodeSize, value: atomRawText(node), text: false, pre: 0, post: 0 })
    })
  })
  return runs
}

export function docToText(doc: ProseNode): string {
  return composerTextRuns(doc)
    .map((run) => run.value)
    .join('')
}

const LANGUAGE = /^(?=[\w+#.-]{1,24}$)(?!.*www\.)/i
const AT_BOUNDARY = /[\s([{<'"：:;,，]/
const INLINE_TOKEN = /(`[^`\n]+`)|(~~[^~\n]+~~)|((?:https?:\/\/|mailto:)[^\s<>"`~]+)/g

export function trimUrlTail(url: string): string {
  let value = url.replace(/[.,;:!?'"]+$/, '')
  while (value.endsWith(')') && (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0)) {
    value = value.slice(0, -1).replace(/[.,;:!?'"]+$/, '')
  }
  return value
}

function textNodesWithMarks(text: string): ProseNode[] {
  const nodes: ProseNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(composerSchema.text(text.slice(last, start)))
    if (match[1]) {
      nodes.push(composerSchema.text(match[1].slice(1, -1), [composerSchema.marks.code.create()]))
      last = start + match[1].length
    } else if (match[2]) {
      nodes.push(composerSchema.text(match[2].slice(2, -2), [composerSchema.marks.strike.create()]))
      last = start + match[2].length
    } else {
      const url = trimUrlTail(match[3])
      if (url) {
        nodes.push(composerSchema.text(url, [composerSchema.marks.link.create({ href: url })]))
        if (url.length < match[3].length) nodes.push(composerSchema.text(match[3].slice(url.length)))
      } else {
        nodes.push(composerSchema.text(match[3]))
      }
      last = start + match[3].length
    }
  }
  if (last < text.length) nodes.push(composerSchema.text(text.slice(last)))
  return nodes
}

function fenceOpen(line: string): { fence: string; language: string } | null {
  const match = /^(`{3,})(\S*)$/.exec(line)
  if (!match) return null
  const language = match[2]
  if (language && !LANGUAGE.test(language)) return null
  return { fence: match[1], language }
}

function commandNameAtStart(line: string, commands?: string[]): string | null {
  if (!commands?.length) return null
  const match = /^\/([^\s]+)(?=\s|$)/.exec(line)
  if (!match) return null
  const typed = match[1]
  return commands.find((name) => name.toLowerCase() === typed.toLowerCase()) ? typed : null
}

function readAtToken(line: string, at: number): { raw: string; path: string; end: number } | null {
  if (line[at] !== '@') return null
  const before = at > 0 ? line[at - 1] : ''
  if (before && !AT_BOUNDARY.test(before)) return null
  const open = line[at + 1]
  if (open === '"' || open === "'") {
    const close = line.indexOf(open, at + 2)
    if (close < 0) return null
    return { raw: line.slice(at, close + 1), path: line.slice(at + 2, close), end: close + 1 }
  }
  let end = at + 1
  while (end < line.length && !/\s/.test(line[end])) end += 1
  const path = line.slice(at + 1, end)
  if (!path) return null
  return { raw: line.slice(at, end), path, end }
}

function atomForToken(token: { raw: string; path: string }, options: ComposerDocumentOptions): ProseNode | null {
  const image = /^(图|img)(\d+)$/.exec(token.path)
  if (image) {
    const n = Number(image[2])
    if (n >= 1 && n <= (options.imageCount ?? 0)) {
      return mentionAtomNode({ kind: 'image', raw: token.raw, path: token.path, label: token.path })
    }
    return null
  }
  if (!(options.mentions ?? []).includes(token.path)) return null
  return mentionAtomNode({ kind: 'mention', raw: token.raw, path: token.path, label: mentionLabelFor(token.path) })
}

function lineContent(line: string, options: ComposerDocumentOptions, marks = true): ProseNode[] {
  const inline = (value: string): ProseNode[] => (marks ? textNodesWithMarks(value) : [composerSchema.text(value)])
  const nodes: ProseNode[] = []
  let rest = line
  const chip = commandNameAtStart(rest, options.commands)
  if (chip) {
    nodes.push(commandChipNode(chip))
    rest = rest.slice(chip.length + 1)
  }
  let buffer = ''
  let at = 0
  while (at < rest.length) {
    if (rest[at] === '@') {
      const token = readAtToken(rest, at)
      const atom = token ? atomForToken(token, options) : null
      if (token && atom) {
        if (buffer) {
          nodes.push(...inline(buffer))
          buffer = ''
        }
        nodes.push(atom)
        at = token.end
        continue
      }
    }
    buffer += rest[at]
    at += 1
  }
  if (buffer) nodes.push(...inline(buffer))
  return nodes
}

function plainLines(lines: string[], options: ComposerDocumentOptions): ProseNode[] {
  return lines.map((line) => composerSchema.node('paragraph', null, lineContent(line, options, false)))
}

function codeBlockNode(language: string, text: string): ProseNode {
  return composerSchema.node('code_block', { language }, text ? composerSchema.text(text) : undefined)
}

export function textToDoc(text: string, options: ComposerDocumentOptions = {}): ProseNode {
  const value = String(text ?? '')
  const lines = value.split('\n')
  const content: ProseNode[] = []
  let index = 0
  while (index < lines.length) {
    const open = fenceOpen(lines[index])
    if (open) {
      let close = index + 1
      while (close < lines.length && lines[close].replace(/[ \t]+$/, '') !== open.fence) close += 1
      if (close < lines.length) {
        content.push(codeBlockNode(open.language, lines.slice(index + 1, close).join('\n')))
        index = close + 1
        continue
      }
    }
    content.push(composerSchema.node('paragraph', null, lineContent(lines[index], options)))
    index += 1
  }
  const doc = composerSchema.node('doc', null, content)
  if (docToText(doc) === value) return doc
  const plain = composerSchema.node('doc', null, plainLines(lines, options))
  if (docToText(plain) === value) return plain
  return composerSchema.node('doc', null, lines.map((line) => composerSchema.node('paragraph', null, line ? composerSchema.text(line) : undefined)))
}

export function inlineNodesForText(text: string): ProseNode[] {
  const lines = String(text ?? '').split('\n')
  const nodes: ProseNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(composerSchema.nodes.hard_break.create())
    if (line) nodes.push(composerSchema.text(line))
  })
  return nodes
}

export function positionForTextOffset(doc: ProseNode, offset: number, bias = 1): number {
  const target = Number.isFinite(offset) ? Math.max(0, offset) : 0
  let consumed = 0
  for (const run of composerTextRuns(doc)) {
    const end = consumed + run.value.length
    if (target <= end) {
      if (run.text) return Math.min(run.to, run.from + Math.max(0, target - consumed - run.pre))
      if (target <= consumed) return run.from
      return target === end || bias > 0 ? run.to : run.from
    }
    consumed = end
  }
  return doc.content.size - 1
}

export function textOffsetForPosition(doc: ProseNode, position: number): number {
  const target = Number.isFinite(position) ? Math.min(position, doc.content.size) : doc.content.size
  let offset = 0
  for (const run of composerTextRuns(doc)) {
    if (run.text) {
      if (target < run.from) return offset
      if (target <= run.to) return offset + run.pre + Math.max(0, target - run.from)
    } else if (target < run.to) {
      return offset
    }
    offset += run.value.length
  }
  return offset
}

export function resolveTextSelection(doc: ProseNode, selection: TextSelection): TextSelection {
  const { start, end } = clampSelection(docToText(doc), selection)
  return {
    start: positionForTextOffset(doc, start),
    end: positionForTextOffset(doc, end)
  }
}

export interface ComposerTextEdit {
  text: string
  cursor: number
}

export function clampSelection(text: string, selection: TextSelection): TextSelection {
  const max = text.length
  const start = Math.max(0, Math.min(selection.start, max))
  const end = Math.max(0, Math.min(selection.end, max))
  return start <= end ? { start, end } : { start: end, end: start }
}

export function caretSelection(text: string, position: number): TextSelection {
  const at = Math.max(0, Math.min(position, text.length))
  return { start: at, end: at }
}

export function hasComposerText(text: string): boolean {
  return text.trim().length > 0
}

export function replaceTextRange(text: string, range: TextSelection, insert: string): ComposerTextEdit {
  const { start, end } = clampSelection(text, range)
  return {
    text: `${text.slice(0, start)}${insert}${text.slice(end)}`,
    cursor: start + insert.length
  }
}

export function insertTextAt(text: string, at: number | TextSelection, insert: string): ComposerTextEdit {
  return replaceTextRange(text, typeof at === 'number' ? caretSelection(text, at) : at, insert)
}

export function appendBlock(text: string, block: string): string {
  return text ? `${text}\n${block}` : block
}

export function prependBlock(text: string, block: string): string {
  return text ? `${block}\n${text}` : block
}
