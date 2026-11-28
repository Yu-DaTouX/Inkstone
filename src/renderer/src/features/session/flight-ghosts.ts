import type { Turn } from '../../../../shared/turns'
import { turnFindText } from './session-find'
import type { GhostRow } from './timeline-flight'

const GHOST_CHARS_PER_PX = 6
const GHOST_CHARS_MAX = 4000

const texts = new WeakMap<Turn, string>()

function ghostText(turn: Turn): string {
  let text = texts.get(turn)
  if (text === undefined) {
    text = turnFindText(turn)
      .replace(/\0/g, '\n')
      .replace(/^\s*(`{3,}|~{3,}).*$/gm, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    texts.set(turn, text)
  }
  return text
}

interface GhostCell {
  el: HTMLDivElement
  body: HTMLDivElement
  text: string
  kind: string
  top: number
  height: number
}

export interface GhostLayer {
  paint(box: HTMLElement, rows: readonly GhostRow[], item: (index: number) => Turn | null): void
  clear(): void
}

export function createGhostLayer(host: HTMLElement): GhostLayer {
  const layer = document.createElement('div')
  layer.className = 'v3-flight-ghosts'
  layer.setAttribute('aria-hidden', 'true')
  const cells: GhostCell[] = []
  let shown = 0
  const cellAt = (slot: number): GhostCell => {
    const existing = cells[slot]
    if (existing) return existing
    const el = document.createElement('div')
    el.className = 'v3-flight-ghost'
    const frame = document.createElement('div')
    frame.className = 'v3-flight-ghost__frame'
    const body = document.createElement('div')
    body.className = 'v3-flight-ghost__body'
    frame.appendChild(body)
    el.appendChild(frame)
    layer.appendChild(el)
    const cell: GhostCell = { el, body, text: '', kind: '', top: Number.NaN, height: Number.NaN }
    cells[slot] = cell
    return cell
  }
  return {
    paint(box, rows, item) {
      if (layer.parentElement !== host) host.appendChild(layer)
      layer.style.top = `${box.offsetTop}px`
      layer.style.left = `${box.offsetLeft}px`
      layer.style.width = `${box.clientWidth}px`
      layer.style.height = `${box.clientHeight}px`
      let used = 0
      for (const row of rows) {
        const turn = item(row.index)
        const full = turn ? ghostText(turn) : ''
        if (!turn || !full) continue
        const limit = Math.min(GHOST_CHARS_MAX, Math.ceil(row.height * GHOST_CHARS_PER_PX))
        const text = full.length > limit ? full.slice(0, limit) : full
        const kind = turn.kind === 'user' ? 'user' : 'reply'
        const cell = cellAt(used)
        used += 1
        if (cell.text !== text) {
          cell.body.textContent = text
          cell.text = text
        }
        if (cell.kind !== kind) {
          cell.el.dataset.kind = kind
          cell.kind = kind
        }
        if (cell.top !== row.top) {
          cell.el.style.transform = `translate3d(0, ${row.top}px, 0)`
          cell.top = row.top
        }
        if (cell.height !== row.height) {
          cell.el.style.height = `${row.height}px`
          cell.height = row.height
        }
        cell.el.hidden = false
      }
      for (let slot = used; slot < shown; slot += 1) cells[slot].el.hidden = true
      shown = used
      layer.hidden = used === 0
    },
    clear() {
      for (let slot = 0; slot < shown; slot += 1) cells[slot].el.hidden = true
      shown = 0
      layer.remove()
    }
  }
}
