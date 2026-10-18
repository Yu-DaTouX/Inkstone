import { useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge } from '../../ui'
import {
  isVisualDataLang,
  parseVisualBlock,
  safeHttpUrl,
  type CardsBlock,
  type FlowBlock,
  type RecordBlock,
  type StatsBlock,
  type StepsBlock,
  type VisualBlockLang,
  type VisualSource
} from '../../../../shared/visual-blocks'
import { VisualChart } from './VisualChart'
import { WidgetBlock } from './WidgetBlock'

const BLOCK_ICONS: Record<string, ReactNode> = {
  check: '✓',
  alert: '!',
  info: 'i',
  sparkles: '✦',
  layers: '▤',
  file: '▧',
  chart: '▦'
}

function BlockIcon({ name }: { name?: string }): JSX.Element | null {
  const glyph = name ? BLOCK_ICONS[name] : undefined
  return glyph ? <span className="v3-visual-icon" aria-hidden>{glyph}</span> : null
}

function useOpenLink(): {
  open: (url: string) => (event: React.MouseEvent) => void
  external: (url: string) => (event: React.MouseEvent) => void
} {
  const openBrowser = useStore((s) => s.openBrowser)
  return {
    open: (url) => (event) => {
      event.preventDefault()
      event.stopPropagation()
      void openBrowser(url)
    },
    external: (url) => (event) => {
      event.preventDefault()
      event.stopPropagation()
      const safe = safeHttpUrl(url)
      if (safe) void window.yan.browser.openExternal(safe)
    }
  }
}

function VisualSources({ items }: { items?: VisualSource[] }): JSX.Element | null {
  const t = useT()
  const link = useOpenLink()
  if (!items?.length) return null
  return (
    <div className="v3-visual-sources" aria-label={t('vb.sources')}>
      {items.map((source, index) => {
        let host = source.url
        try {
          host = new URL(source.url).hostname.replace(/^www\./, '')
        } catch {
        }
        return (
          <a
            key={index}
            className="v3-visual-source-link"
            href={source.url}
            title={source.url}
            onClick={link.open(source.url)}
            onDoubleClick={link.external(source.url)}
          >
            {host}
            {source.label ? <span className="v3-visual-source-label">{source.label}</span> : null}
          </a>
        )
      })}
    </div>
  )
}

function Sparkline({ values, tone }: { values: number[]; tone: 'ok' | 'err' | '' }): JSX.Element {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / span) * 24}`).join(' ')
  return (
    <svg className={`v3-visual-spark ${tone}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Stats({ block }: { block: StatsBlock }): JSX.Element {
  const t = useT()
  return (
    <section className="v3-visual v3-visual-stats-block" data-testid="v3-visual-stats">
      {block.title ? (
        <header className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
        </header>
      ) : null}
      <div className="v3-visual-tiles">
        {block.items.map((item, index) => {
          const good = item.good ?? 'up'
          const tone: 'ok' | 'err' | '' = !item.trend || item.trend === 'flat' ? '' : item.trend === good ? 'ok' : 'err'
          const ratio = item.meter ? Math.min(1, item.meter.value / item.meter.max) : 0
          return (
            <div className="v3-visual-tile" key={index}>
              <span className="v3-visual-stat-label">{item.label}</span>
              <span className="v3-visual-stat-value">{item.value}</span>
              {item.delta || item.trend ? (
                <span className={`v3-visual-delta ${tone}`}>
                  {item.trend === 'up' ? '↑' : item.trend === 'down' ? '↓' : item.trend === 'flat' ? '→' : ''} {item.delta ?? ''}
                </span>
              ) : null}
              {item.spark ? <Sparkline values={item.spark} tone={tone} /> : null}
              {item.meter ? (
                <div
                  className={`v3-visual-meter${ratio >= 0.95 ? ' err' : ratio >= 0.85 ? ' warn' : ''}`}
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={item.meter.max}
                  aria-valuenow={item.meter.value}
                  aria-label={item.label}
                >
                  <span style={{ width: `${Math.round(ratio * 100)}%` } as CSSProperties} />
                </div>
              ) : null}
              {item.detail ? <span className="v3-visual-stat-detail">{item.detail}</span> : null}
            </div>
          )
        })}
      </div>
      {block.source ? <span className="v3-visual-source">{t('vb.source')}：{block.source}</span> : null}
      <VisualSources items={block.sources} />
    </section>
  )
}

function Cards({ block }: { block: CardsBlock }): JSX.Element {
  const t = useT()
  const link = useOpenLink()
  return (
    <section className={`v3-visual v3-visual-cards ${block.layout}`} data-testid="v3-visual-cards">
      {block.title ? (
        <header className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
        </header>
      ) : null}
      <div className="v3-visual-card-list" role="list">
        {block.items.map((item, index) => (
          <div className={`v3-visual-card${item.recommended ? ' recommended' : ''}`} role="listitem" key={index}>
            {item.recommended ? <Badge tone="accent">{t('vb.recommended')}</Badge> : null}
            <div className="v3-visual-card-title">
              {block.layout === 'list' ? <span className="v3-visual-card-index">{index + 1}</span> : null}
              <BlockIcon name={item.icon} />
              <span className="v3-visual-card-name">{item.title}</span>
              {item.badge ? <Badge tone="accent">{item.badge}</Badge> : null}
            </div>
            {item.description ? <p className="v3-visual-card-desc">{item.description}</p> : null}
            {item.meta ? <div className="v3-visual-card-meta">{item.meta}</div> : null}
            {item.links?.length ? (
              <div className="v3-visual-card-links">
                {item.links.map((l, i) => (
                  <a
                    key={i}
                    className="v3-visual-card-link"
                    href={l.url}
                    title={l.url}
                    onClick={link.open(l.url)}
                    onDoubleClick={link.external(l.url)}
                  >
                    {l.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <VisualSources items={block.sources} />
    </section>
  )
}

function Record({ block }: { block: RecordBlock }): JSX.Element {
  const link = useOpenLink()
  const initials = block.title.replace(/\s+/g, '').slice(0, 2)
  return (
    <section className="v3-visual v3-visual-record" data-testid="v3-visual-record">
      <div className="v3-visual-record-head">
        <span className="v3-visual-avatar" aria-hidden>
          {initials}
        </span>
        <div className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
          {block.subtitle ? <span className="v3-visual-sub">{block.subtitle}</span> : null}
        </div>
        {block.badge ? <Badge tone="accent">{block.badge}</Badge> : null}
      </div>
      <dl className="v3-visual-fields">
        {block.fields.map((field, index) => (
          <div className="v3-visual-field" key={index}>
            <dt>
              <BlockIcon name={field.icon} />
              {field.label}
            </dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
      {block.links?.length ? (
        <div className="v3-visual-card-links">
          {block.links.map((l, i) => (
            <a key={i} className="v3-visual-card-link" href={l.url} title={l.url} onClick={link.open(l.url)} onDoubleClick={link.external(l.url)}>
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
      {block.note ? <p className="v3-visual-note">{block.note}</p> : null}
    </section>
  )
}

const TONE_GLYPH = { ok: '✓', warn: '!', err: '✕', info: 'i' } as const

function Flow({ block }: { block: FlowBlock }): JSX.Element {
  return (
    <section className="v3-visual v3-visual-flow" data-testid="v3-visual-flow">
      {block.title ? (
        <header className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
        </header>
      ) : null}
      <div className="v3-visual-steps">
        {block.steps.map((step, index) => (
          <div className="v3-visual-step-wrap" key={index}>
            {index > 0 ? <span className="v3-visual-join" aria-hidden>{block.join === 'plus' ? '+' : '→'}</span> : null}
            <div className="v3-visual-step">
              <BlockIcon name={step.icon} />
              <span className="v3-visual-step-title">{step.title}</span>
              {step.detail ? <span className="v3-visual-step-detail">{step.detail}</span> : null}
            </div>
          </div>
        ))}
      </div>
      {block.result ? (
        <>
          <div className="v3-visual-flow-down" aria-hidden>
            ↓
          </div>
          <div className={`v3-visual-result ${block.result.tone}`}>
            <span aria-hidden>{TONE_GLYPH[block.result.tone]}</span>
            <span>{block.result.text}</span>
          </div>
        </>
      ) : null}
      {block.note ? <p className="v3-visual-note">{block.note}</p> : null}
      <VisualSources items={block.sources} />
    </section>
  )
}

function Steps({ block }: { block: StepsBlock }): JSX.Element {
  const t = useT()
  const [at, setAt] = useState(0)
  const last = block.steps.length - 1
  const step = block.steps[at]
  const go = (next: number): void => setAt(block.loop ? (next + block.steps.length) % block.steps.length : Math.max(0, Math.min(last, next)))
  return (
    <section
      className="v3-visual v3-visual-stepper"
      data-testid="v3-visual-steps"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          go(at + 1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          go(at - 1)
        }
      }}
    >
      {block.title ? (
        <header className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
        </header>
      ) : null}
      <div className="v3-visual-stepper-dots" role="tablist" aria-label={block.title ?? t('vb.steps')}>
        {block.steps.map((s, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={index === at}
            className={`v3-visual-step-dot${index === at ? ' on' : ''}${index < at ? ' done' : ''}`}
            onClick={() => setAt(index)}
            title={s.title}
          >
            <span className="v3-visual-step-n">{index + 1}</span>
            <span className="v3-visual-step-t">{s.title}</span>
          </button>
        ))}
      </div>
      <div className="v3-visual-stepper-panel" role="tabpanel">
        <BlockIcon name={step.icon} />
        <p className="v3-visual-note">{step.body}</p>
      </div>
      <div className="v3-visual-stepper-nav">
        <button type="button" disabled={!block.loop && at === 0} onClick={() => go(at - 1)}>
          {t('vb.prev')}
        </button>
        <span className="v3-visual-stepper-count">
          {at + 1} / {block.steps.length}
          {block.loop ? ` · ${t('vb.loop')}` : ''}
        </span>
        <button type="button" disabled={!block.loop && at === last} onClick={() => go(at + 1)}>
          {t('vb.next')}
        </button>
      </div>
    </section>
  )
}

function DataBlock({
  lang,
  text,
  live,
  fallback,
  pending
}: {
  lang: Exclude<VisualBlockLang, 'mermaid' | 'yan-widget'>
  text: string
  live: boolean
  fallback: ReactNode
  pending: ReactNode
}): JSX.Element {
  const t = useT()
  const parsed = useMemo(() => (isVisualDataLang(lang) ? parseVisualBlock(lang, text) : null), [lang, text])
  if (!parsed) return <>{fallback}</>
  if (!parsed.ok) {
    if (live) return <>{pending}</>
    return (
      <div className="v3-visual-invalid">
        {fallback}
        <div className="v3-visual-invalid-note">{t('vb.invalid', { error: parsed.error })}</div>
      </div>
    )
  }
  switch (parsed.block.kind) {
    case 'chart':
      return <VisualChart block={parsed.block} sources={<VisualSources items={parsed.block.sources} />} />
    case 'stats':
      return <Stats block={parsed.block} />
    case 'cards':
      return <Cards block={parsed.block} />
    case 'record':
      return <Record block={parsed.block} />
    case 'flow':
      return <Flow block={parsed.block} />
    case 'steps':
      return <Steps block={parsed.block} />
  }
}

export interface VisualFenceProps {
  lang: VisualBlockLang
  text: string
  live: boolean
  fallback: ReactNode
  blockId?: string
}

export function VisualFence({ lang, text, live, fallback, blockId }: VisualFenceProps): JSX.Element {
  const t = useT()
  const pending = (
    <div className="v3-visual-pending" role="status">
      {t('vb.pending')}
    </div>
  )
  if (lang === 'yan-widget') {
    return live ? pending : <WidgetBlock html={text} fallback={fallback} blockId={blockId} />
  }
  if (lang === 'mermaid') {
    return <>{fallback}</>
  }
  return <DataBlock lang={lang} text={text} live={live} fallback={fallback} pending={pending} />
}
