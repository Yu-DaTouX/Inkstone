import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { shortProject } from './rail-utils'

/**
 * 主区域顶部 —— 对齐 Agents-Anywhere 的头部。
 *
 * 结构：
 *   第一行：会话标题 + 状态胶囊（项目 / 模型）
 *   第二行：上次聊到 <...>（连续性，轻量；单击跳到那一段）
 *
 * 为什么标题要放在这里而不只在左栏：
 *   左栏会自动收起，收起来之后就完全看不出「现在在哪个会话」。
 *   标题常驻在主区域顶部，不管侧栏在不在，你都知道自己在哪。
 */
export function SessionHeader() {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const cwd = useStore((s) => s.settings?.cwd)
  const sessions = useStore((s) => s.sessions)

  const last = [...messages].reverse().find((m) => m.role === 'user')
  const [flash, setFlash] = useState(false)

  // 会话切换时清掉闪烁态
  useEffect(() => setFlash(false), [session?.sessionId])

  const scrollToLast = (): void => {
    const el = document.querySelector('.msg.user:last-of-type')
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlash(true)
    setTimeout(() => setFlash(false), 600)
  }

  /**
   * 标题取值顺序：
   *   ① 用户起的名字（session_info）
   *   ② 会话列表里那条的标题（= pi 用首条用户消息算出来的）
   *   ③ 首条用户消息（本地兜底，会话还没落盘时用）
   *   ④ 「新会话」（真的什么都没有）
   *
   * 之前恒显示「新会话」—— 一个聊了 20 轮的会话顶部写着「新会话」，
   * 完全看不出在哪个会话里。
   */
  const fromList = sessions.find((x) => x.path === session?.sessionFile)?.title
  const fromFirst = messages.find((m) => m.role === 'user')?.text
  const title =
    session?.sessionName ||
    fromList ||
    (fromFirst ? truncate(fromFirst, 60) : t('header.untitled'))

  return (
    <div className={`shead ${flash ? 'flash' : ''}`} data-testid="session-header">
      <div className="shead-row">
        <h1 className="shead-title" title={title}>
          {title}
        </h1>

        {/* 状态胶囊：项目 + 模型。点模型胶囊进设置 */}
        <button
          className="shead-chip"
          onClick={() => useStore.getState().openSettings('status')}
          title={session?.model?.id}
        >
          <span className={`shead-dot ${session?.isStreaming ? 'busy' : ''}`} />
          <span className="shead-chip-text">
            {cwd ? shortProject(cwd) : '—'}
            {session?.model ? ` · ${session.model.name}` : ''}
          </span>
        </button>
      </div>

      {last ? (
        <div className="shead-sub">
          <span className="shead-sub-label">{t('cont.last')}</span>
          <button className="shead-sub-text" onClick={scrollToLast} title={last.text}>
            {truncate(last.text, 60)}
          </button>
          <span className="shead-sub-time">{relTime(last.timestamp)}</span>
        </div>
      ) : (
        <div className="shead-sub">
          <span className="shead-sub-label">{t('cont.none')}</span>
        </div>
      )}
    </div>
  )
}

function truncate(s: string, n: number): string {
  const clean = s
    .replace(/\s+/g, ' ')
    .replace(/<[^>]{1,40}>/g, '')
    .trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

function relTime(ts?: number): string {
  if (!ts) return ''
  const d = Math.max(0, Date.now() - ts)
  const m = Math.floor(d / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// 兼容既有 import 路径
export { SessionHeader as Continuity }
