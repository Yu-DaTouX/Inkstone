import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { cacheHitRate, currentTurnMessages, formatHitRate, turnUsageOf } from '../../../../shared/turns'

/**
 * 输入框下方的一行小字：本轮输出速度与缓存命中率。由设置「输入框下方显示速度与命中率」控制，默认开。
 * 数据与状态栏的用量详情同源（当前回合的助手消息）；速度只取最近一次生成段，缺报时不编数字。
 */
export function ComposerUsage() {
  const t = useT()
  const enabled = useStore((s) => s.settings?.usageUnderInput !== false)
  const messages = useStore((s) => s.messages)
  if (!enabled) return null
  const turn = currentTurnMessages(messages)
  const speed = [...turn].reverse().find((m) => m.role === 'assistant' && m.speed)?.speed
  const hit = formatHitRate(cacheHitRate(turnUsageOf(turn).usage))
  if (!speed && !hit) return null
  return (
    <div className="composer-usage ui-meta-num" data-testid="composer-usage">
      {speed ? <span><Icon name="activity" size={12} />{t('tok.speed')} {speed >= 10 ? speed.toFixed(0) : speed.toFixed(1)} {t('tok.perSec')}</span> : null}
      {hit ? <span><Icon name="layers" size={12} />{t('sb.kHitRate')} {hit}</span> : null}
    </div>
  )
}
