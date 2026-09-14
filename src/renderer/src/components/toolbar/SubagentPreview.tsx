import { useEffect, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Markdown } from '../chat/MessageParts'

/**
 * 右侧「子代理详情」（方案 8.3）。
 *
 * 内容：任务说明 + 实时转录（复用消息渲染件）+ 停止 / 回到最新。
 * 与文件预览占同一块区域 —— 所以打开它时同样要让主进程把原生网页视图
 * 藏起来（原生 WebContentsView 永远盖在 DOM 之上）。
 *
 * ⚠️ 这里**不停止**任务：关掉预览只是收起视图。
 */
export function SubagentPreview() {
  const t = useT()
  const id = useStore((s) => s.subagentPreviewId)
  const run = useStore((s) => s.subagents.find((r) => r.id === id) ?? null)
  const close = useStore((s) => s.openSubagent)
  const stop = useStore((s) => s.stopSubagent)
  const browserOpen = useStore((s) => s.browserState.open)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  /* 打开/关闭时同步原生视图（与文件预览同一套约定） */
  useEffect(() => {
    if (!id) return
    if (browserOpen) void window.yan.browser.setVisible(false)
    return () => {
      if (useStore.getState().browserState.open) void window.yan.browser.setVisible(true)
    }
  }, [id, browserOpen])

  /* 跟随最新输出（用户上滚时暂停） */
  const count = run?.transcript.length ?? 0
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [count])

  if (!run) return null

  const running = run.status === 'running' || run.status === 'starting'
  const statusText = running
    ? t('sa.running')
    : run.status === 'done'
      ? t('sa.done')
      : run.status === 'cancelled'
        ? t('sa.stopped')
        : t('sa.failed')

  return (
    <div className="sp" data-testid="subagent-preview">
      <div className="sp-head">
        <Icon name="layers" size={12} />
        <span className="sp-title" title={run.task}>
          {run.task}
        </span>
        <span className="spacer" />
        <span className={`sp-state ${run.status}`}>{statusText}</span>
        <button
          className="fp-act"
          onClick={() => close(null)}
          title={t('sa.close')}
          aria-label={t('sa.close')}
          data-testid="subagent-preview-close"
        >
          <Icon name="plus" size={12} className="fp-x" />
        </button>
      </div>

      <div className="sp-meta">
        <span title={run.cwd}>{run.cwd}</span>
        {run.model ? <span>· {run.model}</span> : null}
        {run.error ? <span className="sp-err">· {run.error}</span> : null}
      </div>

      <div
        className="sp-body"
        ref={bodyRef}
        data-testid="subagent-preview-body"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {run.transcript.length === 0 ? (
          <div className="sp-note">{running ? t('sa.waiting') : t('sa.empty')}</div>
        ) : (
          run.transcript.map((msg) => (
            <div key={msg.id} className={`sp-msg ${msg.role}`}>
              <div className="sp-role">{msg.role === 'user' ? t('chat.you') : t('chat.assistant')}</div>
              {msg.thinking ? <div className="sp-think">{msg.thinking.slice(0, 2000)}</div> : null}
              {msg.text ? <Markdown text={msg.text} /> : null}
              {msg.toolCalls?.length ? (
                <div className="sp-tools">
                  {msg.toolCalls.map((c) => (
                    <span key={c.id} className="sp-tool" data-state={c.status}>
                      {c.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {running ? (
        <div className="sp-foot">
          <button className="btn" onClick={() => void stop(run.id)} data-testid="subagent-preview-stop">
            {t('sa.stop')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
