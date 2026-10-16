import type { ITheme } from '@xterm/xterm'
import { APPEARANCE_EVENT } from '../../lib/appearance'

const SENTINEL = 'rgb(1, 2, 3)'

let probe: HTMLElement | null = null

function resolveColor(name: string, fallback: string): string {
  if (typeof document === 'undefined' || !document.body) return fallback
  if (!probe) {
    probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.display = 'none'
    document.body.appendChild(probe)
  }
  probe.style.color = SENTINEL
  probe.style.color = `var(${name}, ${SENTINEL})`
  const value = getComputedStyle(probe).color
  return value && value !== SENTINEL ? value : fallback
}

export function terminalFontFamily(): string {
  if (typeof document === 'undefined') return 'Consolas, monospace'
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Consolas, monospace'
}

export function readTerminalTheme(): ITheme {
  return {
    background: resolveColor('--sunken', '#171716'),
    foreground: resolveColor('--fg', '#ECECE9'),
    cursor: resolveColor('--accent', '#8EA1F5'),
    cursorAccent: resolveColor('--sunken', '#171716'),
    selectionBackground: resolveColor('--sel', 'rgba(142,161,245,.14)'),
    black: resolveColor('--sunken', '#171716'),
    red: resolveColor('--fail', '#F07070'),
    green: resolveColor('--run', '#4CC38A'),
    yellow: resolveColor('--ask', '#E6B450'),
    blue: resolveColor('--accent', '#8EA1F5'),
    magenta: resolveColor('--data-3', '#AE90FF'),
    cyan: resolveColor('--data-2', '#3FC9C4'),
    white: resolveColor('--fg2', '#B5B4AF'),
    brightBlack: resolveColor('--fg3', '#9B9A94'),
    brightRed: resolveColor('--del', '#F28383'),
    brightGreen: resolveColor('--add', '#4CC38A'),
    brightYellow: resolveColor('--ask-t', '#E6B450'),
    brightBlue: resolveColor('--data-6', '#5FB4F0'),
    brightMagenta: resolveColor('--data-4', '#F07AB0'),
    brightCyan: resolveColor('--data-1', '#7A9BFF'),
    brightWhite: resolveColor('--fg', '#ECECE9')
  }
}

export function observeTerminalEnvironment(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!probe) {
    probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.display = 'none'
    document.body?.appendChild(probe)
  }
  const themeObserver = new MutationObserver(onChange)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-density'] })
  window.addEventListener('resize', onChange)
  window.addEventListener(APPEARANCE_EVENT, onChange)
  let dprQuery: MediaQueryList | null = null
  const onDpr = (): void => {
    onChange()
    bindDpr()
  }
  const bindDpr = (): void => {
    dprQuery?.removeEventListener('change', onDpr)
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprQuery.addEventListener('change', onDpr)
  }
  bindDpr()
  return () => {
    themeObserver.disconnect()
    window.removeEventListener('resize', onChange)
    window.removeEventListener(APPEARANCE_EVENT, onChange)
    dprQuery?.removeEventListener('change', onDpr)
  }
}
