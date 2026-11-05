import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

let canvasFontTrimInstalled = false

function trimCanvasFontAssignments(): void {
  if (canvasFontTrimInstalled || typeof CanvasRenderingContext2D === 'undefined') return
  canvasFontTrimInstalled = true
  const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'font')
  const setFont = descriptor?.set
  if (!descriptor || !setFont) return
  Object.defineProperty(CanvasRenderingContext2D.prototype, 'font', {
    ...descriptor,
    set(this: CanvasRenderingContext2D, value: string) {
      setFont.call(this, typeof value === 'string' ? value.trim() : value)
    }
  })
}

export function installTerminalRenderer(term: Terminal, host: HTMLElement): void {
  trimCanvasFontAssignments()
  const addon = new WebglAddon()
  host.dataset.terminalRenderer = 'dom'
  try {
    addon.onContextLoss(() => { addon.dispose(); host.dataset.terminalRenderer = 'dom' })
    term.loadAddon(addon)
    host.dataset.terminalRenderer = 'webgl'
  } catch {
    try { addon.dispose() } catch { }
  }
}

export async function terminalFontReady(options: ITerminalOptions): Promise<void> {
  await document.fonts.load(`${options.fontSize}px ${options.fontFamily}`, 'W').catch(() => undefined)
}

export function installImeFallback(term: Terminal): () => void {
  const textarea = term.textarea
  if (!textarea) return () => {}
  let keyed = false, composed = false
  const keydown = () => { keyed = true }
  const keyup = () => { keyed = false }
  const compositionend = () => { composed = true; setTimeout(() => { composed = false }, 0) }
  const input = (event: Event) => {
    const e = event as InputEvent
    if (!keyed && !composed && term.options.screenReaderMode && e.inputType === 'insertText' && !e.isComposing && e.data) term.input(e.data, true)
    keyed = false
  }
  textarea.addEventListener('keydown', keydown, true)
  textarea.addEventListener('keyup', keyup, true)
  textarea.addEventListener('compositionend', compositionend, true)
  textarea.addEventListener('input', input)
  return () => {
    textarea.removeEventListener('keydown', keydown, true)
    textarea.removeEventListener('keyup', keyup, true)
    textarea.removeEventListener('compositionend', compositionend, true)
    textarea.removeEventListener('input', input)
  }
}
