/**
 * v3 Mermaid 图块（WP-32 · 02 §11.5）。
 *
 * 复用既有离线渲染方式，但外观不再取 v2 令牌：
 *   · 主题由 `mermaid-theme.ts` 从 v3 令牌生成，深浅随 `<html data-theme>`；
 *   · `securityLevel: 'strict'`，图里的 HTML 标签转义、点击事件禁用，输出经 mermaid 净化；
 *   · mermaid 全局状态不能并发初始化，渲染串行；结果按「主题 + 源码」缓存；
 *   · 语法错误或源码过长退回代码块，不静默丢弃。
 *
 * `mermaid` 体积大，按需动态加载，不进首包。
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { VISUAL_MERMAID_MAX_CHARS } from '../../../../shared/visual-blocks'
import { MERMAID_THEME_TOKEN_NAMES, mermaidThemeVariables, type MermaidTokenSet } from './mermaid-theme'
import './artifacts.css'

type MermaidApi = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((module) => module.default)
  return mermaidPromise
}

let queue: Promise<unknown> = Promise.resolve()
let seq = 0
/* 渲染好的 SVG：虚拟列表回收或主题切换回来时直接复用，不再重画。 */
const svgCache = new Map<string, string>()
const SVG_CACHE_LIMIT = 40

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function readTokens(): MermaidTokenSet {
  return {
    dark: document.documentElement.getAttribute('data-theme') === 'dark',
    bg: token(MERMAID_THEME_TOKEN_NAMES.bg),
    surface: token(MERMAID_THEME_TOKEN_NAMES.surface),
    surfaceAlt: token(MERMAID_THEME_TOKEN_NAMES.surfaceAlt),
    sunken: token(MERMAID_THEME_TOKEN_NAMES.sunken),
    fg: token(MERMAID_THEME_TOKEN_NAMES.fg),
    fgMute: token(MERMAID_THEME_TOKEN_NAMES.fgMute),
    line2: token(MERMAID_THEME_TOKEN_NAMES.line2),
    accent: token(MERMAID_THEME_TOKEN_NAMES.accent),
    font: token(MERMAID_THEME_TOKEN_NAMES.font)
  }
}

function themeKey(): string {
  return document.documentElement.getAttribute('data-theme') ?? ''
}

async function renderMermaid(source: string): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid()
    const tokens = readTokens()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: tokens.font || 'sans-serif',
      /* SVG 文字标签：严格模式下 HTML 标签不可用，统一用 SVG 文本测量，避免节点里的字被截。 */
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      themeVariables: mermaidThemeVariables(tokens)
    })
    await mermaid.parse(source)
    const { svg } = await mermaid.render(`v3-mermaid-${++seq}`, source)
    return naturalWidth(svg)
  })
  queue = job.catch(() => undefined)
  return job
}

/** mermaid 输出 width="100%"：按 viewBox 自然宽度显示，只在放不下时由 CSS 缩小。 */
function naturalWidth(svg: string): string {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"/.exec(svg)
  if (!box) return svg
  return svg
    .replace(/<svg([^>]*?)\swidth="100%"/, `<svg$1 width="${Math.ceil(Number(box[1]))}"`)
    .replace(/max-width:\s*[\d.]+px;?/, '')
}

export interface MermaidBlockProps {
  source: string
  /** 语法错误时的代码块回退（由 Markdown 层提供，保持与其它代码块一致）。 */
  fallback: ReactNode
}

export function MermaidBlock({ source, fallback }: MermaidBlockProps): JSX.Element {
  const t = useT()
  const [theme, setTheme] = useState(themeKey)
  const [state, setState] = useState<{ svg?: string; error?: string }>(() => {
    const cached = svgCache.get(`${themeKey()} ${source}`)
    return cached ? { svg: cached } : {}
  })

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(themeKey()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    if (source.length > VISUAL_MERMAID_MAX_CHARS) {
      setState({ error: t('vb.mermaidTooLarge') })
      return undefined
    }
    const cacheKey = `${theme} ${source}`
    const cached = svgCache.get(cacheKey)
    if (cached) {
      setState({ svg: cached })
      return undefined
    }
    renderMermaid(source)
      .then((svg) => {
        if (svgCache.size >= SVG_CACHE_LIMIT) svgCache.delete(svgCache.keys().next().value as string)
        svgCache.set(cacheKey, svg)
        if (alive) setState({ svg })
      })
      .catch((error) => {
        if (alive) setState({ error: String((error as Error)?.message ?? error).split('\n')[0].slice(0, 160) })
      })
    return () => {
      alive = false
    }
  }, [source, theme, t])

  if (state.error) {
    return (
      <div className="v3-visual-invalid">
        {fallback}
        <div className="v3-visual-invalid-note">{t('vb.invalid', { error: state.error })}</div>
      </div>
    )
  }
  if (!state.svg) {
    return (
      <div className="v3-visual-pending" role="status">
        {t('vb.pending')}
      </div>
    )
  }
  return (
    <figure className="v3-visual v3-visual-mermaid" data-testid="v3-visual-mermaid">
      {/* mermaid 严格模式的输出已净化，且这里不执行任何脚本 */}
      <div className="v3-mermaid-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
    </figure>
  )
}
