import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import { useT } from '../../i18n'
import { Notice } from '../../ui'
import { VISUAL_MERMAID_MAX_CHARS } from '../../../../shared/visual-blocks'
import {
  MERMAID_COLOR_TOKENS,
  MERMAID_FONT_SIZE,
  MERMAID_TEXT_TOKENS,
  inlineMermaidTheme,
  mermaidThemeStyle,
  withMinWidth,
  type MermaidThemeVariable
} from './mermaid-theme'
import { SaveAsArtifactButton, shortHash } from './SaveAsArtifact'
import './artifacts.css'

type Pele = typeof import('pele/lazy')

let pelePromise: Promise<Pele> | null = null
function loadPele(): Promise<Pele> {
  if (!pelePromise) {
    pelePromise = import('pele/lazy').catch((error: unknown) => {
      pelePromise = null
      throw error
    })
  }
  return pelePromise
}

let seq = 0
const svgCache = new Map<string, string>()
const SVG_CACHE_LIMIT = 40
const themeStyle = mermaidThemeStyle() as CSSProperties

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function sanitizeDiagramSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'],
    FORBID_TAGS: ['a', 'image', 'foreignObject', 'style'],
    USE_PROFILES: { svg: true, svgFilters: true }
  })
}

async function renderMermaid(source: string): Promise<string> {
  const pele = await loadPele()
  const { svg, width } = await pele.renderAsync(source, {
    idPrefix: `v3-mermaid-${++seq}-`,
    fontFamily: token(MERMAID_TEXT_TOKENS['--pele-font']) || 'sans-serif',
    fontFamilyMono: token(MERMAID_TEXT_TOKENS['--pele-font-mono']) || undefined,
    fontSize: MERMAID_FONT_SIZE,
    links: false,
    images: false,
    autoDirection: false
  })
  return withMinWidth(sanitizeDiagramSvg(svg), width)
}

function resolvedColor(host: HTMLElement, name: string): string {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = `var(${name})`
  host.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return resolved
}

function standaloneSvg(host: HTMLElement | null, svg: string): string {
  if (!host) return svg
  const computed = getComputedStyle(host)
  const values: Partial<Record<MermaidThemeVariable, string>> = {}
  for (const name of Object.keys(MERMAID_COLOR_TOKENS) as MermaidThemeVariable[]) values[name] = resolvedColor(host, name)
  for (const name of Object.keys(MERMAID_TEXT_TOKENS) as MermaidThemeVariable[]) values[name] = computed.getPropertyValue(name)
  return inlineMermaidTheme(svg, values)
}

export interface MermaidBlockProps {
  source: string
  fallback: ReactNode
}

export function MermaidBlock({ source, fallback }: MermaidBlockProps): JSX.Element {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ svg?: string; error?: string }>(() => {
    const cached = svgCache.get(source)
    return cached ? { svg: cached } : {}
  })

  useEffect(() => {
    let alive = true
    if (source.length > VISUAL_MERMAID_MAX_CHARS) {
      setState({ error: t('vb.mermaidTooLarge') })
      return undefined
    }
    const cached = svgCache.get(source)
    if (cached) {
      setState({ svg: cached })
      return undefined
    }
    renderMermaid(source)
      .then((svg) => {
        if (svgCache.size >= SVG_CACHE_LIMIT) svgCache.delete(svgCache.keys().next().value as string)
        svgCache.set(source, svg)
        if (alive) setState({ svg })
      })
      .catch((error) => {
        if (alive) setState({ error: String((error as Error)?.message ?? error).split('\n')[0].slice(0, 160) })
      })
    return () => {
      alive = false
    }
  }, [source, t])

  if (state.error) {
    return (
      <div className="v3-visual-invalid">
        {fallback}
        <Notice tone="fail" compact className="v3-visual-invalid-note">{t('vb.invalid', { error: state.error })}</Notice>
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
      <div ref={host} className="v3-mermaid-svg" style={themeStyle} dangerouslySetInnerHTML={{ __html: state.svg }} />
      <div className="v3-visual-actions">
        <SaveAsArtifactButton
          filename={`diagram-${shortHash(source)}.svg`}
          sourceKey={`mermaid:${shortHash(source)}`}
          content={() => standaloneSvg(host.current, state.svg ?? '')}
        />
      </div>
    </figure>
  )
}
