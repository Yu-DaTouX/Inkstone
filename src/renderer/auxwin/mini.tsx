/**
 * 迷你小窗渲染入口（v3 WP-12）。
 *
 * 置顶状态小窗：列出 AttentionService 汇总出的注意项（等你确认 / 停滞 / 失败 /
 * 运行中 / 排队 / 刚完成），点击回到主窗口对应会话。状态点复用 `patterns/RunDot`，
 * 外观只在 auxwin.css 写版面。Esc 关闭。
 */
import { StrictMode, useEffect, useMemo, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { X } from 'lucide-react'
import './apply-theme'
import '../src/design/index.css'
import { IconButton } from '../src/ui'
import { I18nProvider } from '../src/i18n'
import { RunDot } from '../src/patterns/RunDot'
import type { RunPhase } from '../../shared/runs'
import { auxBridge, type MiniItem, type MiniStateView } from './aux-bridge'
import { auxDict, statusWord } from './aux-i18n'
import './auxwin.css'

/** 把迷你小窗的状态键折回 `RunPhase`，让 `RunDot`（patterns）继续是唯一状态点实现。 */
function phaseOf(item: MiniItem): RunPhase {
  switch (item.statusKey) {
    case 'needs-you':
      return { kind: 'needs-you', since: item.since, request: { id: item.runId, type: 'confirm', summary: item.title } }
    case 'stalled':
      return { kind: 'stalled', since: item.since, cause: 'no-output' }
    case 'failed':
      return { kind: 'failed', at: item.since, cause: 'host', message: '', seen: !item.unread }
    case 'done':
      return { kind: 'done', at: item.since, seen: !item.unread }
    case 'queued':
      return { kind: 'queued', since: item.since, reason: 'followup' }
    default:
      return { kind: 'running', since: item.since, activity: 'waiting-model' }
  }
}

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function MiniApp(): ReactElement {
  const bridge = auxBridge()
  const [view, setView] = useState<MiniStateView | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!bridge) return
    void bridge.mini.state().then(setView)
    const off = bridge.onPush((msg) => {
      if (msg.ch === 'mini') setView(msg.payload)
    })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [bridge])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') bridge?.mini.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bridge])

  const locale = view?.locale ?? 'zh-CN'
  const dict = useMemo(() => auxDict(locale), [locale])
  const items = view?.items ?? []

  return (
    <div className="aux aux--mini">
      <header className="aux-mini__head">
        <span className="aux-mini__title">{dict.miniTitle}</span>
        <span className="aux-mini__count">{items.length}</span>
        <IconButton aria-label={dict.miniClose} onPress={() => bridge?.mini.close()}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </header>
      {items.length === 0 ? (
        <p className="aux-mini__empty">{dict.miniEmpty}</p>
      ) : (
        <ul className="aux-mini__list">
          {items.map((item) => (
            <li key={item.runId}>
              <button
                type="button"
                className="aux-mini__row"
                onClick={() => bridge?.mini.open(item)}
                title={`${item.code} · ${item.title}`}
              >
                <RunDot phase={phaseOf(item)} unread={item.unread} code={item.code} />
                <span className="aux-mini__text">
                  <span className="aux-mini__name">{item.title || item.code}</span>
                  <span className="aux-mini__meta">
                    {item.code} · {statusWord(locale, item.statusKey)}
                  </span>
                </span>
                <span className="aux-mini__time">{elapsed(item.since, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <MiniApp />
      </I18nProvider>
    </StrictMode>
  )
}
