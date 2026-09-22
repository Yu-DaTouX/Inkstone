import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { Usage } from '../../../../shared/ipc'
import { cacheHitRate, currentTurnMessages, formatHitRate } from '../../../../shared/turns'

/**
 * 底部的用量条。
 *
 * 内容（从左到右）：
 *   速度 · 输入 · 输出 · 缓存命中率
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
 *   因为 output 含 thinking 与工具参数）。所以拿不到就显示「生成中」状态，
 *   而不是编一个看着精确的假数字。用时本身留在回合页脚，这里不再重复显示。
 *
 * ⚠️ **模型 + 思考强度选择器不在这里**（用户要求：放回输入框内部）：
 *   它在 `Composer.tsx` 的 `.composer-bar` 里（`Pickers.tsx` 的
 *   `ModelThinkingPicker`）。曾经为它在本组件里保留过一道「pi 未就绪也必须
 *   渲染模型入口」的降级分支 —— 入口搬进输入框后不再需要，但**容器仍要保留**：
 *   `layout` / `tokens` 探针与视觉矩阵都按 `[data-testid="usagebar"]` 定位
 *   输入区下方的这条横带，`return null` 会让它们找不到对象。
 */
export function UsageBar() {
  const t = useT()
  const session = useStore((s) => s.session)
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => !!s.session?.isStreaming)

  /* ---- 本轮用量 ---- */
  // 全 0 的 usage 不算数：流式途中 provider 可能先报一个全 0
  // （pi 文档：may remain zero until completion），否则会闪一下 "输入 0 输出 0"
  const hasNumbers = (x?: Usage): boolean =>
    !!x && (x.input > 0 || x.output > 0 || x.cacheRead > 0 || x.cacheWrite > 0)

  /*
   * ⚠️ 只在**当前回合**里找用量/速度（`currentTurnMessages`）。
   *    在整个历史里倒着找「最近一次非零 usage」会把上一轮的数字标成本轮实时值：
   *    新一轮刚开始流式时还没报 usage，旧轮有值 —— 于是速度带上了 live 标记、
   *    「生成中」状态被跳过；新一轮最终不报 usage 时，账单也一直在显示旧轮数据。
   */
  const turnMessages = currentTurnMessages(messages)
  const last = [...turnMessages].reverse().find((m) => m.role === 'assistant' && hasNumbers(m.usage))
  const u = last?.usage

  /* ---- 缓存命中率（算法在 shared/turns.ts，有单测） ---- */
  const hit = cacheHitRate(u)
  const hitLabel = formatHitRate(hit)

  /*
   * 本轮是否已经结算。
   *
   * ⚠️ 判定必须落在**当前回合**上：只看全局最后一条消息的话，
   *    新一轮还没回消息时 `messages` 末尾是用户消息（或干脆没有），
   *    于是拿不到任何结论；而跨回合取旧 usage 又会让比例看着像本轮的。
   */
  const lastMsg = turnMessages[turnMessages.length - 1]
  const settled = !streaming || (lastMsg?.role === 'assistant' && hasNumbers(lastMsg.usage))
  const cacheExtra = settled ? (hitLabel ?? (u ? '—' : undefined)) : t('tok.settling')

  const liveSpeed = streaming && (u?.output ?? 0) > 0 ? last?.speed : undefined
  const doneSpeed = !streaming ? last?.speed : undefined
  const speed = liveSpeed ?? doneSpeed

  /*
   * 一点用量信息都没有时，原来整条不渲染（`return null`）—— 但那会
   * **连模型选择器一起藏掉**：pi 未就绪 / 启动超时 / 凭证失效时 session 为 null，
   * 用户既看不到当前状态，也没有入口去换模型（用户报的「看不到模型选择」）。
   * 所以降级为只渲染「模型」入口，不铺一排空用量项。
   */
  if (!session?.model && !u) {
    /*
     * 一点用量都没有：只留容器，不铺一排空用量项。
     * 模型入口在输入框内（见上方注释），所以这里不需要降级渲染任何控件。
     */
    return <div className="usagebar" data-testid="usagebar" data-state="no-usage" />
  }

  return (
    <div className="usagebar" data-testid="usagebar">
      {/* 左组：本轮账单。模型/强度在最右，上下文在右栏。 */}

      {streaming && !speed ? (
        <span className="ub-item" title={t('tok.liveTip')}>
          <span className="ub-value">
            {t('tok.generating')}
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
          extra={cacheExtra}
          title={t('tok.cacheTip', {
            read: fmtTok(u?.cacheRead ?? 0),
            write: fmtTok(u?.cacheWrite ?? 0),
            hit: !settled ? t('tok.settling') : hit === null ? '—' : hit.toFixed(2)
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
  live,
  testId
}: {
  label: string
  value: string
  unit?: string
  extra?: string
  title?: string
  dim?: boolean
  live?: boolean
  /** 给视觉矩阵/探针用的稳定钩子（不是样式类名） */
  testId?: string
}) {
  return (
    <span className={`ub-item ${dim ? 'dim' : ''}`} title={title} {...(testId ? { 'data-testid': testId } : {})}>
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
