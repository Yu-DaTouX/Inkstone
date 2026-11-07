export type MessageBlock =
  | { kind: 'text' | 'code' | 'heading' | 'list'; value: string; lang?: string }
  | { kind: 'table'; value: string; rows: string[][] }
  | { kind: 'image'; value: string; url: string }

const FOLD_AT = 8000
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/
const TABLE_RULE = /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/

export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function parse(text: string, folded: boolean): MessageBlock[] {
  const lines = (folded ? `${text.slice(0, FOLD_AT)}\n…` : text).replace(/\r\n/g, '\n').split('\n')
  const blocks: MessageBlock[] = []
  let code: string[] | null = null
  let lang = ''
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      if (code) { blocks.push({ kind: 'code', value: code.join('\n'), lang }); code = null }
      else { code = []; lang = fence[1] }
      continue
    }
    if (code) { code.push(line); continue }
    if (!line.trim()) { if (blocks.at(-1)?.kind !== 'text' || blocks.at(-1)?.value !== '') blocks.push({ kind: 'text', value: '' }); continue }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      const rows = [tableCells(line)]
      const raw = [line, lines[index + 1]]
      index += 2
      while (index < lines.length && TABLE_ROW.test(lines[index])) { rows.push(tableCells(lines[index])); raw.push(lines[index]); index++ }
      index--
      blocks.push({ kind: 'table', value: raw.join('\n'), rows })
      continue
    }
    const image = IMAGE_LINE.exec(line)
    if (image) { blocks.push({ kind: 'image', value: image[1], url: image[2] }); continue }
    const heading = /^#{1,3}\s+(.+)$/.exec(line)
    const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line)
    blocks.push({ kind: heading ? 'heading' : list ? 'list' : 'text', value: heading?.[1] ?? list?.[1] ?? line })
  }
  if (code) blocks.push({ kind: 'code', value: code.join('\n'), lang })
  return blocks
}

export function parseMessageBlocks(text: string, folded: boolean): MessageBlock[] {
  return parse(text, folded)
}
