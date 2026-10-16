/**
 * v3 终端的 xterm 外观：全部从 `design/tokens.css` 读，不写死第二份色值。
 *
 * xterm 拿不到 CSS 变量，必须喂具体颜色。tokens 里的颜色多为 `light-dark(...)`，
 * 自定义属性的 computed value 不保证已经解析成 `rgb()`；直接取值塞给 canvas
 * 可能无效。这里用一次性探针元素落到真实元素上读 `color`，让 `color-scheme`
 * 自己选深浅，再交给 xterm。主题切换时组件重新调用即可。
 */
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

/** 代码字体：与 tokens 的 `--font-mono` 同一真源。 */
export function terminalFontFamily(): string {
  if (typeof document === 'undefined') return 'Consolas, monospace'
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Consolas, monospace'
}

/** 当前主题下的 xterm 颜色（深浅由 `<html data-theme>` / color-scheme 决定）。 */
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

/**
 * 观察会影响终端像素尺寸的环境变化：
 *   · `data-theme` / 代码字体外观事件 → 重新取主题（xterm 不读 CSS 变量）；
 *   · 系统缩放 / 显示器 DPR 变化 → 让调用方重新测量。
 * 返回清理函数。
 */
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
  /* DPR 变了要重测：每次触发后按新的 devicePixelRatio 重绑，否则只响应一次。 */
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
