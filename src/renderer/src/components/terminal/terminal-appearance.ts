import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/** Canvas font measurement needs a resolved family, rather than a CSS var(). */
export function terminalAppearance(): ITerminalOptions {
  const styles = getComputedStyle(document.documentElement)
  return {
    fontFamily: styles.getPropertyValue('--font-code').trim() || 'Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    letterSpacing: 0,
    cursorBlink: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    screenReaderMode: true,
    theme: {
      background: styles.getPropertyValue('--bg-0').trim(),
      foreground: styles.getPropertyValue('--fg').trim(),
      cursor: styles.getPropertyValue('--accent').trim(),
      selectionBackground: styles.getPropertyValue('--accent-soft').trim()
    }
  }
}

export function installTerminalRenderer(term: Terminal, host: HTMLElement): void {
  const addon = new WebglAddon()
  host.dataset.terminalRenderer = 'dom'
  try {
    addon.onContextLoss(() => { addon.dispose(); host.dataset.terminalRenderer = 'dom' })
    term.loadAddon(addon)
    host.dataset.terminalRenderer = 'webgl'
  } catch {
    // GPU capability is optional; keep the terminal usable through the default renderer.
    try { addon.dispose() } catch { /* An addon may fail before activation. */ }
  }
}

export async function terminalFontReady(options: ITerminalOptions): Promise<void> {
  // Measure the Latin cell only after the bundled font is available; CJK occupies two cells.
  await document.fonts.load(`${options.fontSize}px ${options.fontFamily}`, 'W').catch(() => undefined)
}

/**
 * With screenReaderMode on (kept for the accessible text tree), xterm ignores `insertText` input
 * events. Text that arrives after a keydown is still sent by xterm (the key itself, or its textarea
 * diff after an IME `Process` key), and composition commits go through its composition helper.
 * Some Windows IMEs commit candidates as a bare `insertText` with no keydown at all; xterm would
 * drop that, so forward exactly those commits.
 */
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
