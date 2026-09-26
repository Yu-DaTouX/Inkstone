import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { ForkPoint, PeekResult, UIMessage } from '../../../../shared/ipc'

/**
 * 会话预览（地图内的右侧抽屉）。
 *
 * 为什么需要它：地图里点开一张卡片如果直接切走，用户「只想看一眼内容」
 * 就得来回切视图。预览是**只读**的（`peekSession` 的有损读取），
 * 真正的动作（打开会话 / 从此分叉）都在抽屉底部显式给出。
 *
 * 分叉只对**当前会话**提供：pi 的 fork 走当前活动 runner，别的会话
 * 得先切过去 —— 与其做一个会失败的按钮，不如说明白。
 */

const MAX_MESSAGES = 30
const CLIP = 600
const FORK_CLIP = 90

interface Props {
  path: string
  /** 是不是当前打开的会话（决定分叉是否可用） */
  isCurrent: boolean
  onOpen: (path: string) => void
  onClose: () => void
  onFork: (entryId: string) => void
  forking?: boolean
}

const roleKey = (
  role: UIMessage['role']
): 'map.previewYou' | 'map.previewBash' | 'map.previewAssistant' =>
  role === 'user' ? 'map.previewYou' : role === 'bash' ? 'map.previewBash' : 'map.previewAssistant'

const clip = (text: string, limit: number): string => {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

export function SessionPreview({ path, isCurrent, onOpen, onClose, onFork, forking }: Props): React.JSX.Element {
  const t = useT()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<PeekResult | null>(null)
  const [points, setPoints] = useState<ForkPoint[]>([])
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    window.yan
      .peekSession(path)
      .then((res) => {
        if (!alive) return
        setData(res)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [path])

  useEffect(() => {
    if (!isCurrent) {
      setPoints([])
      return undefined
    }
    let alive = true
    window.yan
      .forkPoints()
      .then((list) => {
        if (alive) setPoints(list)
      })
      .catch(() => {
        /* 取不到分叉点只是少了这个入口，不影响预览本身 */
        if (alive) setPoints([])
      })
    return () => {
      alive = false
    }
  }, [isCurrent, path])

  /* 打开就贴到底：预览想回答的是「最近发生了什么」 */
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data])

  const messages = data?.messages ?? []
  const shown = messages.slice(-MAX_MESSAGES)
  const hidden = messages.length - shown.length
  const tools = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0)

  return (
    <aside className="wb-preview" data-testid="map-preview" aria-label={t('map.preview')}>
      <header className="wb-preview-head">
        <Icon name="chat-round" size={12} />
        <span className="wb-preview-title" data-testid="map-preview-title">
          {t('map.preview')}
        </span>
        <button
          className="wb-preview-btn"
          onClick={() => onOpen(path)}
          data-testid="map-preview-open"
          title={t('map.previewOpen')}
        >
          {t('map.previewOpen')}
        </button>
        <button
          className="wb-preview-btn"
          onClick={onClose}
          aria-label={t('map.previewClose')}
          title={t('map.previewClose')}
          data-testid="map-preview-close"
        >
          <Icon name="sidebar-right" size={12} />
        </button>
      </header>

      <div className="wb-preview-stat" data-testid="map-preview-stat">
        {loading
          ? t('map.previewLoading')
          : error
            ? t('map.previewError', { msg: error })
            : t('map.previewStats', { messages: messages.length, tools })}
      </div>

      <div className="wb-preview-body" ref={bodyRef}>
        {loading || error ? null : messages.length === 0 ? (
          <p className="wb-preview-note">{t('map.previewEmpty')}</p>
        ) : (
          <>
            {hidden > 0 ? <p className="wb-preview-note">{t('map.previewTruncated', { n: hidden })}</p> : null}
            {shown.map((m) => (
              <article className="wb-preview-msg" key={m.id} data-role={m.role}>
                <div className="wb-preview-meta">
                  <span className="wb-preview-role">{t(roleKey(m.role))}</span>
                  {m.timestamp ? <span>{new Date(m.timestamp).toLocaleTimeString()}</span> : null}
                  {m.toolCalls && m.toolCalls.length > 0 ? (
                    <span className="wb-preview-tools">
                      {t('map.previewTools', { n: m.toolCalls.length, names: m.toolCalls.map((c) => c.name).join(' ') })}
                    </span>
                  ) : null}
                </div>
                {m.text.trim() ? (
                  <p className="wb-preview-text">{clip(m.text, CLIP)}</p>
                ) : (
                  <p className="wb-preview-note">{t('map.previewNoText')}</p>
                )}
              </article>
            ))}
          </>
        )}
      </div>

      {isCurrent && points.length > 0 ? (
        <div className="wb-preview-fork" data-testid="map-preview-fork">
          <div className="wb-preview-fork-head">{t('map.forkPoints')}</div>
          {[...points].reverse().map((p) => (
            <button
              key={p.entryId}
              className="wb-preview-fork-row"
              onClick={() => onFork(p.entryId)}
              disabled={forking}
              title={`${t('map.forkHere')} · ${p.text}`}
              data-testid="map-preview-fork-row"
            >
              <Icon name="chevron-right" size={12} />
              <span className="wb-preview-fork-text">{clip(p.text, FORK_CLIP) || t('map.previewNoText')}</span>
              <span className="wb-preview-fork-action">{t('map.forkHere')}</span>
            </button>
          ))}
          <p className="wb-preview-note">{t('map.forkHint')}</p>
        </div>
      ) : null}
    </aside>
  )
}
