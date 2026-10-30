import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findTerminalLinks, type TerminalFileLink, type TerminalLinkMatch } from './terminal-links'

interface CellPosition {
  x: number
  y: number
  width: number
}

interface LogicalLine {
  text: string
  cells: CellPosition[]
}

export interface TerminalLinkActions {
  checkFile(link: TerminalFileLink): Promise<boolean>
  open(link: TerminalLinkMatch, event: MouseEvent): void
  hover(active: boolean): void
}

const MAX_WRAPPED_ROWS = 12
const MAX_LINKS_PER_ROW = 12

function readLogicalLine(term: Terminal, row: number): LogicalLine | null {
  const buffer = term.buffer.active
  let first = row
  let guard = 0
  while (first > 0 && buffer.getLine(first)?.isWrapped && guard < MAX_WRAPPED_ROWS) {
    first -= 1
    guard += 1
  }
  const cell = buffer.getNullCell()
  const cells: CellPosition[] = []
  let text = ''
  for (let index = first; index < first + MAX_WRAPPED_ROWS * 2; index += 1) {
    const line = buffer.getLine(index)
    if (!line) break
    if (index !== first && !line.isWrapped) break
    for (let x = 0; x < line.length; x += 1) {
      const current = line.getCell(x, cell)
      if (!current) break
      const width = current.getWidth()
      if (width === 0) continue
      const chars = current.getChars() || ' '
      for (let unit = 0; unit < chars.length; unit += 1) cells.push({ x: x + 1, y: index + 1, width })
      text += chars
    }
  }
  return text.trim() ? { text, cells } : null
}

function toLink(match: TerminalLinkMatch, cells: readonly CellPosition[], actions: TerminalLinkActions): ILink | null {
  const start = cells[match.start]
  const end = cells[match.end - 1]
  if (!start || !end) return null
  return {
    range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } },
    text: match.text,
    decorations: { underline: true, pointerCursor: true },
    activate: (event) => actions.open(match, event),
    hover: () => actions.hover(true),
    leave: () => actions.hover(false)
  }
}

export function createTerminalLinkProvider(term: Terminal, actions: TerminalLinkActions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const logical = readLogicalLine(term, bufferLineNumber - 1)
      if (!logical) {
        callback(undefined)
        return
      }
      const matches = findTerminalLinks(logical.text)
        .filter((match) => {
          const first = logical.cells[match.start]
          const last = logical.cells[match.end - 1]
          return !!first && !!last && first.y <= bufferLineNumber && last.y >= bufferLineNumber
        })
        .slice(0, MAX_LINKS_PER_ROW)
      if (matches.length === 0) {
        callback(undefined)
        return
      }
      void Promise.all(
        matches.map(async (match) => {
          if (match.kind === 'url') return match
          const exists = await actions.checkFile(match).catch(() => false)
          return exists ? match : null
        })
      ).then((resolved) => {
        const links = resolved
          .filter((match): match is TerminalLinkMatch => !!match)
          .map((match) => toLink(match, logical.cells, actions))
          .filter((link): link is ILink => !!link)
        callback(links.length ? links : undefined)
      })
    }
  }
}
