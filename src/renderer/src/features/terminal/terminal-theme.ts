import type { ITheme } from '@xterm/xterm'
import { APPEARANCE_EVENT } from '../../lib/appearance'

const SENTINEL = 'rgb(1, 2, 3)'

let probe: HTMLElement | null = null

function resolveColor(name: string, fallback: string): string {
  return resolveExpression(`var(${name}, ${SENTINEL})`, fallback)
}

function readableData(index: number, fallback: string): string {
  return resolveExpression(`color-mix(in srgb, var(--data-${index}) 72%, var(--fg))`, fallback)
}

function resolveExpression(expression: string, fallback: string): string {
  if (typeof document === 'undefined' || !document.body) return fallback
  if (!probe) {
    probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.display = 'none'
    document.body.appendChild(probe)
  }
  probe.style.color = SENTINEL
  probe.style.color = expression
  const value = getComputedStyle(probe).color
  return value && value !== SENTINEL ? toRgb(value) : fallback
}

function toRgb(value: string): string {
  const match = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value)
  if (!match) return value
  const [r, g, b] = [match[1], match[2], match[3]].map((channel) => Math.round(Math.min(1, Math.max(0, Number(channel))) * 255))
  return match[4] === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${match[4]})`
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
    red: resolveColor('--fail-t', '#F28383'),
    green: resolveColor('--ok', '#4CC38A'),
    yellow: resolveColor('--ask-t', '#E6B450'),
    blue: resolveColor('--accent', '#8EA1F5'),
    magenta: readableData(3, '#BFAAF9'),
    cyan: readableData(2, '#6FD3CE'),
    white: resolveColor('--fg2', '#B5B4AF'),
    brightBlack: resolveColor('--fg3', '#9B9A94'),
    brightRed: resolveColor('--del', '#F28383'),
    brightGreen: resolveColor('--add', '#4CC38A'),
    brightYellow: resolveColor('--ask-t', '#E6B450'),
    brightBlue: readableData(6, '#86C4EE'),
    brightMagenta: readableData(4, '#EF9AC0'),
    brightCyan: readableData(1, '#9AB2F9'),
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
