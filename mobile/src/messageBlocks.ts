export type MessageBlock = { kind: 'text' | 'code' | 'heading' | 'list'; value: string; lang?: string }

const FOLD_AT = 8000
function parse(text: string, folded: boolean): MessageBlock[] {
  const lines = (folded ? `${text.slice(0, FOLD_AT)}\n…` : text).replace(/\r\n/g, '\n').split('\n')
  const blocks: MessageBlock[] = []
  let code: string[] | null = null
  let lang = ''
  for (const line of lines) {
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      if (code) { blocks.push({ kind: 'code', value: code.join('\n'), lang }); code = null }
      else { code = []; lang = fence[1] }
      continue
    }
    if (code) { code.push(line); continue }
    if (!line.trim()) { if (blocks.at(-1)?.kind !== 'text' || blocks.at(-1)?.value !== '') blocks.push({ kind: 'text', value: '' }); continue }
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
