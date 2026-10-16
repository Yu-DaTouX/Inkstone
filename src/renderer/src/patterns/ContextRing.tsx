import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, Popover } from 'react-aria-components'
import { Button } from '../ui'
import { useT, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
import { contextBreakdown, type ContextCategory } from '../state/context-breakdown'
import './context-ring.css'

/**
 * 输入框底部一行里的上下文环（WP-24）。
 *
 * 权威边界：**总量只认 `stats.contextUsage`**（Agent 报的），分类占比才由
 * 当前可见消息文本估算（纯逻辑在 `state/context-breakdown.ts`）。
 * 没有可信总量时显示 `—`，绝不按窗口编一个百分比 —— 那会让人以为
 * 「还剩一半」而在下一次请求里溢出。
 *
 * 与 v2 的 `NativeContextSection` / `ComposerUsage` 的关系：只取「上下文占用」
 * 这一件事，会话统计与 token 明细仍归各自工位，这里不重复表达。
 */

/** 把 token 数缩成 `383.8k / 1M` 一类的短写法；只用于展示。 */
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

const CATEGORY_LABEL: Record<ContextCategory | 'free', MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools',
  free: 'ctx.cat.free'
}

/**
 * `stats.contextUsage` 与当前模型对齐后才可信。
 *
 * 旧快照（换了模型但统计还没跟上）不能冒充当前值 —— 与主进程
 * `contextUsage.modelKey` 的约定一致。
 */
export function useContextUsage() {
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const usage = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const matches = !!usage && (!usage.modelKey || usage.modelKey === modelKey)
  const reported = matches ? usage?.contextWindow : undefined
  const windowSize =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? reported
      : session?.model?.contextWindow ?? 0
  const known = matches && typeof usage?.tokens === 'number' && windowSize > 0
  const tokens = known ? usage!.tokens! : 0
  const percent = known ? (tokens / windowSize) * 100 : null
  const tone: 'ok' | 'warn' | 'err' =
    percent !== null && percent >= 95 ? 'err' : percent !== null && percent >= 80 ? 'warn' : 'ok'
  return { session, usage, matches, windowSize, known, tokens, percent, tone }
}

/** 12px 的占用圆环；空数据时只画轨道，不画会误导的弧。 */
function Ring({ percent, tone }: { percent: number | null; tone: 'ok' | 'warn' | 'err' }) {
  const R = 5
  const C = 2 * Math.PI * R
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const dash = (clamped / 100) * C
  return (
    <svg className="ctx-ring-svg" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle className="ctx-ring-track" cx="7" cy="7" r={R} fill="none" strokeWidth="2" />
      {percent !== null ? (
        <circle
          className="ctx-ring-arc"
          data-tone={tone}
          cx="7"
          cy="7"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${C}`}
          transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  )
}

export function ContextRing({ className }: { className?: string } = {}) {
  const t = useT()
  const { session, usage, matches, windowSize, known, tokens, percent, tone } = useContextUsage()
  const messages = useStore((s) => s.messages)
  const compact = useStore((s) => s.compact)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  /* 切会话 / 换模型就收起：数字整体换掉，浮层不能停留在上一条的结论上。 */
  const boundKey = `${session?.sessionId ?? ''}|${session?.model?.provider ?? ''}/${session?.model?.id ?? ''}`
  useEffect(() => {
    setOpen(false)
  }, [boundKey])

  const since = session?.lastCompaction?.status === 'completed' ? session.lastCompaction.startedAt : undefined
  const slices = useMemo(
    () => (known ? contextBreakdown(messages, tokens, since) : []),
    [known, messages, tokens, since]
  )
  const share = (n: number): number => (windowSize > 0 ? (n / windowSize) * 100 : 0)
  const rows = known
    ? [...slices.filter((s) => s.tokens > 0), { id: 'free' as const, tokens: Math.max(0, windowSize - tokens) }]
    : []
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const text = known ? `${Math.round(percent!)}%` : '—'
  const title = known
    ? t('ctx.tip', { used: shortTokens(tokens), win: shortTokens(windowSize), pct: Math.round(percent!) })
    : t('ctx.usageUnknown')

  return (
    <div className={`ctx-ring-wrap ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="ctx-ring"
        data-tone={known ? tone : ''}
        aria-label={t('rp.context')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <Ring percent={percent} tone={tone} />
        <span className="ctx-ring-text ui-meta-num" data-testid="ctx-ring-text">
          {text}
        </span>
      </button>
      <Popover
        className="ctx-pop"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="top start"
        offset={8}
      >
        <Dialog className="ctx-dialog" aria-label={t('rp.context')}>
          <div className="ctx-window-head" data-testid="ctx-main">
            <span className="ctx-pop-title">{t('ctx.window')}</span>
            <span className={`ctx-window-total ui-meta-num ${known && tone !== 'ok' ? tone : ''}`} data-testid="ctx-tokens">
              {known ? `${shortTokens(tokens)} / ${shortTokens(windowSize)} (${Math.round(percent!)}%)` : '—'}
            </span>
          </div>
          <div
            className="ctx-usage-bar"
            role="img"
            aria-label={known ? t('quota.usedInline', { pct: Math.round(percent!) }) : t('ctx.usageUnknown')}
          >
            {slices.map((s) =>
              s.tokens > 0 ? (
                <i key={s.id} className={`ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} />
              ) : null
            )}
          </div>
          {rows.length ? (
            <ul className="ctx-legend" data-testid="ctx-breakdown">
              {rows.map((r) => (
                <li key={r.id} className={r.id === 'free' ? 'free' : undefined}>
                  <i className={`ctx-swatch c-${r.id}`} aria-hidden />
                  <span className="ctx-legend-name">{t(CATEGORY_LABEL[r.id])}</span>
                  <span className="ctx-legend-num ui-meta-num">{shortTokens(r.tokens)}</span>
                  <span className="ctx-legend-num ui-meta-num">{`${share(r.tokens).toFixed(1)}%`}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {matches && usage?.tokens === null ? (
            <div className="ctx-note" data-testid="ctx-unknown">
              {t('ctx.afterCompact')}
            </div>
          ) : null}
          <p className="ctx-note ctx-estimate-note">{t('ctx.estimateHint')}</p>
          <div className="ctx-actions">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!session?.sessionId || busy}
              data-testid="ctx-compact-now"
              onPress={() => void compact()}
            >
              {t('status.compact')}
            </Button>
          </div>
        </Dialog>
      </Popover>
    </div>
  )
}
