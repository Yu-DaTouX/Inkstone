import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import type { SessionSummary } from '../../../../shared/ipc'
import { Button, IconButton } from '../ui'

/** 删除成功后的轻量通知状态（非模态） */
export interface TrashNotice {
  /** 主进程给的撤销 token；没有时只提示、不可撤销 */
  token: string | null
  title: string
  busy: boolean
  error: string
  restored: boolean
  /** 文件已移动但会话列表没刷新成功 —— 要如实告知，不能显示成完全成功 */
  refreshFailed: boolean
}

/**
 * 删除成功 / 恢复过程中的轻量通知条。
 *
 * 视觉规范（方案 15.3）：
 *   · 不圈定焦点、用 `role="status"` 播报，不打断用户输入；
 *   · 撤销是**普通主要动作**，不用危险红色；
 *   · 不用 `.send`（那是输入框发送按钮的圆形专用样式）。
 */
export function TrashNoticeBar({ notice, onUndo, onClose }: {
  notice: TrashNotice
  onUndo: () => void
  onClose: () => void
}) {
  const t = useT()
  const label = notice.restored
    ? t('rail.restoredNotice')
    : notice.busy
      ? t('rail.restoring')
      : notice.refreshFailed
        ? t('rail.deletedRefreshFailed')
        : t('rail.deletedNotice')

  return (
    <div className="rail-trash" role="status" aria-live="polite" data-testid="trash-notice">
      <Icon name={notice.restored ? 'check' : 'history'} size={12} />
      <span className="rail-trash-text">
        <span>{label}</span>
        {!notice.restored ? (
          <span className="rail-trash-name" title={notice.title}>
            {notice.title}
          </span>
        ) : null}
        {notice.error ? (
          <span className="rail-trash-err" role="alert">
            {notice.error}
          </span>
        ) : null}
      </span>
      <span className="spacer" />
      {!notice.restored && notice.token ? (
        <Button disabled={notice.busy} onClick={onUndo} data-testid="trash-undo">
          {notice.busy ? t('rail.restoring') : t('rail.undoDelete')}
        </Button>
      ) : null}
      <IconButton icon="close" iconSize={12} label={t('rail.noticeDismiss')} onClick={onClose} />
    </div>
  )
}

/**
 * 删除会话不能依赖浏览器原生 confirm：它没有明确告知“可撤销”，在某些
 * Electron 环境下也不能稳定地呈现。这里要求输入完整标题再启用动作。
 *
 * 交互分成四段（方案 15.2）：确认 → 进行 → 成功（关模态 + 轻量通知）
 * → 失败（框内给原因）。删除成功不再弹第二个模态框。
 */
export function SessionDeleteDialog({ session, onClose, onDeleted }: {
  session: SessionSummary
  onClose: () => void
  /** 删除成功：把撤销 token 交给通知条（token 可能为 null） */
  onDeleted: (token: string | null, refreshFailed: boolean) => void
}) {
  const t = useT()
  const descendantCount = useStore((state) => {
    const children = new Map<string, string[]>()
    for (const item of state.sessions) {
      if (!item.parentSession) continue
      const list = children.get(item.parentSession) ?? []
      list.push(item.path)
      children.set(item.parentSession, list)
    }
    const walk = (path: string): number => (children.get(path) ?? []).reduce((n, child) => n + 1 + walk(child), 0)
    return walk(session.path)
  })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirmed = typed.trim() === session.title.trim()

  /*
   * 这个弹窗是条件渲染的（deleteTarget 非空才挂载），所以 open 恒为 true。
   * Esc 以前写在 input 的 onKeyDown 上 —— 只在焦点在输入框时生效，
   * 且与「点取消」是两条不同的路径。现在统一到这里。
   */
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)

  const remove = async (): Promise<void> => {
    if (!confirmed || busy) return
    setBusy(true)
    setError('')
    const res = await window.yan.deleteSession(session.path)
    if (!res.ok) {
      /* 删除失败：留在确认框里说清原因，保留取消与重试 */
      setError(res.error ?? t('rail.deleteFailed'))
      setBusy(false)
      return
    }
    /*
     * 文件已移动，但**列表刷新可能失败**。
     * 刷新失败不能重跑删除（那会真删两次），只如实告诉用户，
     * 撤销 token 照常交给通知条。
     */
    let refreshFailed = false
    try {
      await useStore.getState().refreshSessions()
    } catch {
      refreshFailed = true
    }
    onDeleted(res.undoToken ?? null, refreshFailed)
  }

  /* 挂到 body：左栏收起（display:none）时对话框不能跟着消失 */
  return createPortal(
    <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
    <div className="modal rail-delete-dialog" ref={panel}>
      <div className="modal-head">
        <Icon name="alert-circle" size={14} />
        <span className="modal-title" id="delete-session-title">{t('rail.deleteTitle')}</span>
      </div>
      <div className="modal-message">
        {t('rail.deleteExplain', { name: session.title })}{descendantCount ? ` ${t('rail.deleteBranches', { n: descendantCount })}` : ''}
      </div>
      <input
        className="modal-input"
        autoFocus
        value={typed}
        placeholder={session.title}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void remove() }}
      />
      {error ? <div className="rail-delete-error" role="alert">{error}</div> : null}
      <div className="modal-foot">
        <Button onClick={onClose} disabled={busy}>{t('ui.cancel')}</Button>
        <span className="spacer" />
        <Button variant="danger" disabled={!confirmed || busy} onClick={() => void remove()}>
          {busy ? t('rail.deleting') : t('rail.deleteAction')}
        </Button>
      </div>
    </div>
  </div>,
    document.body
  )
}

/**
 * 「移除项目」确认框。
 *
 * 这不是删磁盘目录：项目只从砚的项目列表里移除，它的会话跟着进「已归档项目」，
 * 随时点「恢复项目」能回来。既然可逆，为什么还要确认 —— 项目行会立刻从列表消失，
 * 先花一屏文字说清「东西去哪了」，比让用户事后自己找归档区便宜。
 */
export function ProjectRemoveDialog({ project, onClose, onRemoved }: {
  project: { id: string; name: string }
  onClose: () => void
  onRemoved: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      /*
       * 从 store 现读一次列表，不用弹窗打开时那份快照：展开菜单期间列表
       * 可能已经被别处改过（新建/归档），拿旧副本整体写回会把那次改动吞掉。
       */
      const projects = (useStore.getState().settings?.projects ?? []).map((item) =>
        item.id === project.id ? { ...item, archived: true, updatedAt: Date.now() } : item
      )
      await useStore.getState().patchSettings({ projects })
      onRemoved()
    } catch {
      /* 写设置失败：留在框里说清原因，别让项目行悄悄变成“已移除” */
      setError(t('rail.removeProjectFailed'))
      setBusy(false)
    }
  }

  /* 挂到 body：左栏收起（display:none）时对话框不能跟着消失 */
  return createPortal(
    <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="remove-project-title">
    <div className="modal rail-delete-dialog" ref={panel}>
      <div className="modal-head">
        <Icon name="alert-circle" size={14} />
        <span className="modal-title" id="remove-project-title">{t('rail.removeProjectTitle')}</span>
      </div>
      <div className="modal-message">{t('rail.removeProjectExplain', { name: project.name })}</div>
      {error ? <div className="rail-delete-error" role="alert">{error}</div> : null}
      <div className="modal-foot">
        <Button onClick={onClose} disabled={busy}>{t('ui.cancel')}</Button>
        <span className="spacer" />
        <Button variant="danger" disabled={busy} onClick={() => void remove()} data-testid="rail-remove-project-confirm">
          {busy ? t('rail.removingProject') : t('rail.removeProjectAction')}
        </Button>
      </div>
    </div>
  </div>,
    document.body
  )
}
