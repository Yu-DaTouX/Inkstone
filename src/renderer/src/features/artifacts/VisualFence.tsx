import { useMemo, type JSX, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge, Meter, Notice, Stat, StatGrid } from '../../ui'
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
  const openLink = useStore((s) => s.openLink)
  return {
    open: (url) => (event) => {
      event.preventDefault()
      event.stopPropagation()
      void openLink(url)
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
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 64},${18 - ((value - min) / span) * 16}`).join(' ')
  return (
    <svg className={`v3-visual-spark ${tone}`} width="64" height="20" viewBox="0 0 64 20" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function meterTone(ratio: number): 'ink' | 'ask' | 'fail' {
  return ratio >= 0.95 ? 'fail' : ratio >= 0.85 ? 'ask' : 'ink'
}

function Stats({ block }: { block: StatsBlock }): JSX.Element {
  const t = useT()
  const columns = block.items.length > 4 ? 3 : block.items.length
  return (
    <section className="v3-visual v3-visual-stats-block" data-testid="v3-visual-stats">
      {block.title ? (
        <header className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
        </header>
      ) : null}
      <StatGrid columns={columns} className="v3-visual-statgrid">
        {block.items.map((item, index) => {
          const good = item.good ?? 'up'
          const tone: 'ok' | 'err' | '' = !item.trend || item.trend === 'flat' ? '' : item.trend === good ? 'ok' : 'err'
          const arrow = item.trend === 'up' ? '↑' : item.trend === 'down' ? '↓' : item.trend === 'flat' ? '→' : ''
          const ratio = item.meter ? Math.min(1, item.meter.value / item.meter.max) : 0
          return (
            <Stat
              key={index}
              label={item.label}
              value={item.value}
              unit={item.delta || arrow ? <span className={`v3-visual-delta ${tone}`}>{`${arrow}${item.delta ?? ''}`}</span> : undefined}
              aside={item.spark && item.spark.length > 1 ? <Sparkline values={item.spark} tone={tone} /> : undefined}
              footer={
                item.meter || item.detail ? (
                  <>
                    {item.meter ? (
                      <Meter value={item.meter.value} maxValue={item.meter.max} tone={meterTone(ratio)} aria-label={item.label} className="v3-visual-meter" />
                    ) : null}
                    {item.detail ? <span className="v3-visual-stat-detail">{item.detail}</span> : null}
                  </>
                ) : undefined
              }
            />
          )
        })}
      </StatGrid>
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
            <div className="v3-visual-card-title">
              {block.layout === 'list' ? <span className="v3-visual-card-index">{index + 1}</span> : null}
              <BlockIcon name={item.icon} />
              <span className="v3-visual-card-name">{item.title}</span>
              {item.recommended ? <Badge tone="accent">{t('vb.recommended')}</Badge> : null}
              {item.badge ? <Badge tone="neutral">{item.badge}</Badge> : null}
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
  return (
    <section className="v3-visual v3-visual-record" data-testid="v3-visual-record">
      <header className="v3-visual-head">
        <span className="v3-visual-title">{block.title}</span>
        {block.subtitle ? <span className="v3-visual-sub">{block.subtitle}</span> : null}
        {block.badge ? <Badge tone="neutral" className="v3-visual-badge">{block.badge}</Badge> : null}
      </header>
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
        {block.result ? (
          <div className="v3-visual-step-wrap">
            <span className="v3-visual-join" aria-hidden>{block.join === 'plus' ? '=' : '→'}</span>
            <div className={`v3-visual-result ${block.result.tone}`}>
              <i className="v3-visual-result-dot" aria-hidden />
              <span>{block.result.text}</span>
            </div>
          </div>
        ) : null}
      </div>
      {block.note ? <p className="v3-visual-note">{block.note}</p> : null}
      <VisualSources items={block.sources} />
    </section>
  )
}

function Steps({ block }: { block: StepsBlock }): JSX.Element {
  const t = useT()
  return (
    <section className="v3-visual v3-visual-stepper" data-testid="v3-visual-steps">
      {block.title ? (
        <header className="v3-visual-head">
          <span className="v3-visual-title">{block.title}</span>
        </header>
      ) : null}
      <ol className="v3-visual-timeline" aria-label={block.title ?? t('vb.steps')}>
        {block.steps.map((step, index) => (
          <li className="v3-visual-tl-item" key={index}>
            <span className="v3-visual-tl-n" aria-hidden>
              {index + 1}
            </span>
            <div className="v3-visual-tl-body">
              <span className="v3-visual-tl-title">
                <BlockIcon name={step.icon} />
                {step.title}
              </span>
              {step.body ? <span className="v3-visual-tl-text">{step.body}</span> : null}
            </div>
          </li>
        ))}
      </ol>
      {block.loop ? <p className="v3-visual-note">↻ {t('vb.loop')}</p> : null}
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
        <Notice tone="fail" compact className="v3-visual-invalid-note">{t('vb.invalid', { error: parsed.error })}</Notice>
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
  lang: Exclude<VisualBlockLang, 'mermaid'>
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
  return <DataBlock lang={lang} text={text} live={live} fallback={fallback} pending={pending} />
}
