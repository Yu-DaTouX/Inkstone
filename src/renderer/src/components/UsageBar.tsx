import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { Usage } from '../../../shared/ipc'
import { ModelThinkingPicker } from './Pickers'

/**
 * 底部的用量条（合并版）。
 *
 * 曾经是两条：输入框**上方**放「模型 + 上下文」，**下方**放「输入/输出/缓存/速度」。
 * 现在合成一条，放在输入框下方 —— 因为它们是同一件事的两面：
 * 「这次花了多少、上下文还有多满」，分开看要抬两次眼。
 *
 * 内容（从左到右）：
 *   模型 · 思考档 │ 上下文 进度条 已用/上限 百分比 │ 输入 输出 缓存命中 │ 速度 │ 本轮花费
 *
 * 关于「输出速度」的诚实做法（别改成估算）：
 *   实测这个 provider 到结束才报 usage（138 个流式事件里只有 2 个带 usage，
 *   第一个在第 137 位），所以流式期间算不出真实 tok/s。
 *   又实测过「字符数 ÷ 时间」不可靠（tokens/char 在 0.4~93 之间跳，
 *   因为 output 含 thinking 与工具参数）。所以拿不到就显示「生成中 Ns」，
 *   而不是编一个看着精确的假数字。
 */
export function UsageBar() {
  const t = useT()
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => !!s.session?.isStreaming)
  const openSettings = useStore((s) => s.openSettings)

  /* ---- 流式计时（拿不到实时 usage 时用） ---- */
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const id = setInterval(() => setTick((v) => v + 1), 200)
    return () => clearInterval(id)
  }, [streaming])

  // 计时基准：**流式开始那一刻**。
  // 不能按「当前消息 id 变了」记 —— 流式刚开始最后一条还是用户消息，
  // 助手消息 message_start 后才新建，id 一变计时就归零，看着像卡了一下。
  const startRef = useRef(0)
  const wasStreaming = useRef(false)
  if (streaming && !wasStreaming.current) startRef.current = Date.now()
  wasStreaming.current = streaming
  void tick
  const elapsedSec = streaming && startRef.current ? (Date.now() - startRef.current) / 1000 : 0

  /* ---- 上下文 ---- */
  const cu = stats?.contextUsage
  const ctxUsed = cu?.tokens ?? 0
  const ctxWin = cu?.contextWindow ?? session?.model?.contextWindow ?? 0
  const ctxPct = cu?.percent ?? (ctxUsed && ctxWin ? (ctxUsed / ctxWin) * 100 : 0)
  const ctxTone = ctxPct >= 95 ? 'err' : ctxPct >= 85 ? 'warn' : 'ok'

  /* ---- 本轮用量 ---- */
  // 全 0 的 usage 不算数：流式途中 provider 可能先报一个全 0
  // （pi 文档：may remain zero until completion），否则会闪一下 "输入 0 输出 0"
  const hasNumbers = (x?: Usage): boolean =>
    !!x && (x.input > 0 || x.output > 0 || x.cacheRead > 0 || x.cacheWrite > 0)

  const last = [...messages].reverse().find((m) => m.role === 'assistant' && hasNumbers(m.usage))
  const u = last?.usage
  const promptTotal = (u?.input ?? 0) + (u?.cacheRead ?? 0)
  const hit = promptTotal > 0 ? (u!.cacheRead / promptTotal) * 100 : 0

  /**
   * 命中率的显示。
   *
   * 实测这个 provider 的命中率最高能到 99.98%（几乎整段提示词都在缓存里），
   * 用 toFixed(0) 会显示成刺眼的「100%」—— 看着像算错了。
   * 所以：
   *   < 99.5%  保留一位小数（92.4%）
   *   >= 99.5% 显示 ≈100%（明确表示「几乎全部」，不假装是精确的 100）
   */
  const hitLabel =
    promptTotal === 0 ? undefined : hit >= 99.5 ? '≈100%' : hit.toFixed(1) + '%'

  const liveSpeed = streaming && (u?.output ?? 0) > 0 ? last?.speed : undefined
  const doneSpeed = !streaming ? last?.speed : undefined
  const speed = liveSpeed ?? doneSpeed

  // 一点信息都没有就不占位
  if (!session?.model && !ctxWin && !u) return null

  const nf = new Intl.NumberFormat('en-US')

  return (
    <div className="usagebar" data-testid="usagebar">
      {/* 模型不在这里重复显示 —— 顶部头部已常驻。
          这里只放「花的钱」相关：上下文 / 本轮用量 / 速度 */}

      <span className="ub-sep" />

      <span className="ub-sep" />

      {/* 速度 */}
      {streaming && !speed ? (
        <span className="ub-item" title={t('tok.liveTip')}>
          <span className="ub-label">{t('tok.speed')}</span>
          <span className="ub-value">
            {t('tok.generating')}
            <span className="ub-unit">{elapsedSec.toFixed(1)}s</span>
            <span className="ub-live" />
          </span>
        </span>
      ) : (
        <Item
          label={t('tok.speed')}
          value={speed ? fmtSpeed(speed) : '—'}
          unit={speed ? t('tok.perSec') : undefined}
          title={
            last?.elapsedMs
              ? t('tok.speedTip', { n: (last.elapsedMs / 1000).toFixed(1) })
              : t('tok.speedUnknown')
          }
          dim={!speed}
          live={!!liveSpeed}
        />
      )}

      {/* 上下文 + 本轮用量：紧跟模型标签靠右（输入框的那一侧）。
          用户要求「上下文靠右」，且整条要收窄居中。 */}
      {/* 本轮：输入 / 输出 / 缓存命中 */}
      <span className="ub-turn">
        <Item label={t('tok.in')} value={u ? fmtTok(u.input) : '—'} dim={!u || streaming} />
        <Item label={t('tok.out')} value={u ? fmtTok(u.output) : '—'} dim={!u || (streaming && !liveSpeed)} />
        <Item
          label={t('tok.cache')}
          value={u?.cacheRead ? fmtTok(u.cacheRead) : '—'}
          extra={hitLabel}
          title={t('tok.cacheTip', {
            read: fmtTok(u?.cacheRead ?? 0),
            write: fmtTok(u?.cacheWrite ?? 0),
            hit: hit.toFixed(1)
          })}
          dim={!u?.cacheRead || streaming}
        />
      </span>

      {/* 上下文 */}
      {ctxWin ? (
        <button
          className={`ub-ctx ${ctxTone}`}
          onClick={() => openSettings('status')}
          title={t('ctx.tip', {
            used: nf.format(ctxUsed),
            win: nf.format(ctxWin),
            pct: ctxPct.toFixed(1)
          })}
          data-testid="ub-ctx"
        >
          <span className="ub-label">{t('ctx.label')}</span>
          <span className="ub-meter">
            <i style={{ width: `${Math.min(100, ctxPct)}%` }} />
          </span>
          <span className="ub-num">
            {fmtTok(ctxUsed)}
            <span className="ub-slash">/</span>
            {fmtTok(ctxWin)}
          </span>
          <span className={`ub-pct ${ctxTone}`}>{ctxPct.toFixed(ctxPct < 10 ? 1 : 0)}%</span>
        </button>
      ) : null}

      {session?.isCompacting ? (
        <span className="ub-compacting">
          <Icon name="refresh" size={12} className="spin" />
          {t('status.compacting')}
        </span>
      ) : null}

      <span className="ub-sep" />


      {/* 模型 + 强度：Codex 风格的组合标签，放在最右 */}
      <ModelThinkingPicker />

      {/* 花费：沉到最右 */}
      {stats && stats.cost > 0 ? (
        <span className="ub-cost" title={t('tok.cost')}>
          ${stats.cost.toFixed(3)}
        </span>
      ) : null}
    </div>
  )
}

function Item({
  label,
  value,
  unit,
  extra,
  title,
  dim,
  live
}: {
  label: string
  value: string
  unit?: string
  extra?: string
  title?: string
  dim?: boolean
  live?: boolean
}) {
  return (
    <span className={`ub-item ${dim ? 'dim' : ''}`} title={title}>
      <span className="ub-label">{label}</span>
      <span className="ub-value">
        {value}
        {unit ? <span className="ub-unit">{unit}</span> : null}
        {extra ? <span className="ub-extra">{extra}</span> : null}
        {live ? <span className="ub-live" /> : null}
      </span>
    </span>
  )
}

/** token 数缩写：1.0M / 65.5k / 940 */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return n.toLocaleString('en-US')
}

/** 速度：整数 + tok/s，慢的时候给一位小数 */
function fmtSpeed(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(1)
}
