import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { Usage } from '../../../../shared/ipc'
import { cacheHitRate, formatHitRate } from '../../../../shared/turns'
import { ModelThinkingPicker } from '../Pickers'

/**
 * 底部的用量条。
 *
 * 内容（从左到右）：
 *   速度 · 输入 · 输出 · 缓存命中率 ......... 模型 + 强度（最右）
 *
 * ⚠️ 上下文**不在这里**（用户要求改位置）：它搬到了右栏第一块。
 *
 * ⚠️ 单位：之前只写 `467` / `634`，没有任何单位 —— 用户报「缺少单位」。
 *   现在统一带 `tok`（速度本来就是 `tok/s`）。
 *
 * ⚠️ 命中率的算法在 shared/turns.ts 的 `cacheHitRate()`，**不在**这里 ——
 *   因为它的分母容易写错（见那边的说明），值得单测钉住。
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
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => !!s.session?.isStreaming)

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

  /* ---- 本轮用量 ---- */
  // 全 0 的 usage 不算数：流式途中 provider 可能先报一个全 0
  // （pi 文档：may remain zero until completion），否则会闪一下 "输入 0 输出 0"
  const hasNumbers = (x?: Usage): boolean =>
    !!x && (x.input > 0 || x.output > 0 || x.cacheRead > 0 || x.cacheWrite > 0)

  const last = [...messages].reverse().find((m) => m.role === 'assistant' && hasNumbers(m.usage))
  const u = last?.usage

  /* ---- 缓存命中率（算法在 shared/turns.ts，有单测） ---- */
  const hit = cacheHitRate(u)
  const hitLabel = formatHitRate(hit)

  const liveSpeed = streaming && (u?.output ?? 0) > 0 ? last?.speed : undefined
  const doneSpeed = !streaming ? last?.speed : undefined
  const speed = liveSpeed ?? doneSpeed

  // 一点信息都没有就不占位
  if (!session?.model && !u) return null

  return (
    <div className="usagebar" data-testid="usagebar">
      {/* 左组：本轮账单。模型/强度在最右，上下文在右栏。 */}

      {streaming && !speed ? (
        <span className="ub-item" title={t('tok.liveTip')}>
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

      <span className="ub-dot" />

      <span className="ub-turn">
        <Item
          label={t('tok.in')}
          value={u ? fmtTok(u.input) : '—'}
          unit={u ? t('tok.unit') : undefined}
          dim={!u || streaming}
        />
        <span className="ub-dot" />
        <Item
          label={t('tok.out')}
          value={u ? fmtTok(u.output) : '—'}
          unit={u ? t('tok.unit') : undefined}
          dim={!u || (streaming && !liveSpeed)}
        />
        <span className="ub-dot" />
        {/* 缓存：值 = 缓存读取量，额外显示**命中率**（用户明确要求） */}
        <Item
          label={t('tok.cache')}
          value={u?.cacheRead ? fmtTok(u.cacheRead) : '—'}
          unit={u?.cacheRead ? t('tok.unit') : undefined}
          extra={hitLabel ?? undefined}
          title={t('tok.cacheTip', {
            read: fmtTok(u?.cacheRead ?? 0),
            write: fmtTok(u?.cacheWrite ?? 0),
            hit: hit === null ? '—' : hit.toFixed(1)
          })}
          dim={!u?.cacheRead || streaming}
        />
      </span>

      <span className="spacer" />

      {session?.isCompacting ? (
        <span className="ub-compacting">
          <Icon name="refresh" size={12} className="spin" />
          {t('status.compacting')}
        </span>
      ) : null}

      {/* 模型 + 强度：终端风格组合标签，放在最右 */}
      <ModelThinkingPicker />
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
