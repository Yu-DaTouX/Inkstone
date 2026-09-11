import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state/store'

export { SessionHeader, SessionHeader as Continuity } from './SessionHeader'

/* ------------------------------------------------------------------ 评审条 */

/**
 * 审阅条：有未确认记忆时才出现。
 *
 * 与「改动审阅」的方向性差异：那边接受是隐式的；这边确认是**显式**的 ——
 * 一条错误记忆会长期影响判断，不能默认接受。
 */
export function ReviewBar() {
  const t = useT()
  const groups = useStore((s) => s.groups)
  const openSettings = useStore((s) => s.openSettings)
  const [dismissed, setDismissed] = useState(false)
  const lastCount = useRef(groups.impressions.length)

  // 有新印象出现时重新出现
  useEffect(() => {
    if (groups.impressions.length > lastCount.current) setDismissed(false)
    lastCount.current = groups.impressions.length
  }, [groups.impressions.length])

  const n = groups.impressions.length
  if (n === 0 || dismissed) return null

  // 「都记对了」= 全部确认；「逐条过」= 打开设置的记忆页（那里能逐条点）
  const confirmAll = async (): Promise<void> => {
    for (const m of groups.impressions) {
      await window.yan.memoryConfirm(m.id, true)
    }
    await useStore.getState().refreshMemory()
    setDismissed(true)
  }

  return (
    <div className="review">
      <div className="review-inner">
        <span className="review-ico">!</span>
        <span>
          <span className="cnt">{n}</span> <span>{t('review.pending')}</span>
        </span>
        <span className="spacer" />
        <span className="why">{t('review.why')}</span>
        <button className="btn" onClick={() => openSettings('memory')}>
          {t('review.each')}
        </button>
        <button className="btn" onClick={() => void confirmAll()}>
          {t('review.acceptAll')}
        </button>
      </div>
    </div>
  )
}

export { EmptyStream } from './EmptyStream'
