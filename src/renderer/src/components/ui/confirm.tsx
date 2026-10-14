/**
 * 应用内确认对话框（`ConfirmDialog` / `useConfirm`）。
 *
 * 统一替换渲染端原来的 `window.confirm()`：系统原生框不跟深浅主题、同步阻塞
 * 渲染进程，焦点与内置浏览器视图层级也不受砚的浮层协调管控。
 *
 * 行为契约：
 * - `useConfirm()` 返回 `(options) => Promise<boolean>`，取消 / Esc / 外点 /
 *   组件卸载一律结算 `false`；
 * - 多次调用**排队串行**，一次只显示一个，结算后自动显示下一个；
 * - 取消按钮在 DOM 焦点顺序首位并初始聚焦，Enter 只触发当前焦点，不会误批准；
 * - 复用 `modalLayer` 的焦点圈定 / 恢复与 `acquireOverlayBlocker`，让
 *   WebContentsView（内置浏览器）在确认框打开时避让；
 * - 调用方组件卸载时，名下未决请求按 `false` 结算，不把旧操作留给未来；
 * - Provider 卸载或整队列取消（会话切换）同样按 `false` 结算。
 *
 * 与既有审批卡（ApprovalCard）是两套东西：审批卡回答模型发出的问题，
 * 这里只回答砚自己的破坏性动作，不要互相混用。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button } from './index'
import { createConfirmQueue, type ConfirmOptions, type ConfirmQueue, type ConfirmRequest } from './confirm-queue'

export type { ConfirmOptions, ConfirmTone } from './confirm-queue'

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmQueue | null>(null)

/** 全局唯一挂载：放在 App 根部，全应用共享一条确认队列。 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queue = useMemo(() => createConfirmQueue(), [])
  /* Provider 卸载（整个界面被拆）时，别把未决 Promise 悬着 */
  useEffect(() => () => queue.cancelAll(), [queue])
  return (
    <ConfirmContext.Provider value={queue}>
      {children}
      <ConfirmHost queue={queue} />
    </ConfirmContext.Provider>
  )
}

/**
 * 取确认函数。
 *
 * 每个调用方实例拿一个 scope；实例卸载时，它发起但还没处理的请求全部按
 * `false` 结算。这样「会话切换 / 组件卸载后弹出旧确认」不会真的执行旧操作。
 */
export function useConfirm(): ConfirmFn {
  const queue = useContext(ConfirmContext)
  const scope = useMemo(() => Symbol('confirm-scope'), [])
  useEffect(() => {
    if (!queue) return undefined
    return () => queue.cancelScope(scope)
  }, [queue, scope])
  const confirm = useCallback((options: ConfirmOptions) => {
    if (!queue) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
    return queue.enqueue(options, scope)
  }, [queue, scope])
  if (!queue) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
  return confirm
}

/** 关闭整条确认队列（会话切换等跨作用域场景）。未决请求按未确认结算。 */
export function useCancelConfirms(): () => void {
  const queue = useContext(ConfirmContext)
  const cancel = useCallback(() => queue?.cancelAll(), [queue])
  if (!queue) throw new Error('useCancelConfirms 必须在 <ConfirmProvider> 内使用')
  return cancel
}

function ConfirmHost({ queue }: { queue: ConfirmQueue }): React.JSX.Element | null {
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const requests = useSyncExternalStore(queue.subscribe, queue.snapshot)
  const active = requests.length > 0
  const closeHead = useCallback(() => {
    const head = queue.snapshot()[0]
    if (head) queue.settle(head.id, false)
  }, [queue])
  const { isTop } = useModalLayer(active, closeHead)
  /* 只要还有确认在排队就保持 blocker：切换下一条时不放开内置浏览器视图 */
  useEffect(() => {
    if (!active) return undefined
    return acquireOverlayBlocker('confirm-dialog')
  }, [active, acquireOverlayBlocker])

  const current = requests[0]
  if (!current) return null
  /* key 保证换到下一条时重新挂载：重置焦点圈定与恢复点 */
  return <ConfirmDialog key={current.id} queue={queue} request={current} queued={requests.length - 1} isTop={isTop} />
}

function ConfirmDialog({ queue, request, queued, isTop }: { queue: ConfirmQueue; request: ConfirmRequest; queued: number; isTop: boolean }): React.JSX.Element {
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const detailId = useId()
  const { options } = request
  const close = useCallback(() => queue.settle(request.id, false), [queue, request.id])

  useFocusTrap(panel, true, isTop)

  const tone = options.tone ?? 'normal'
  const describedBy = [options.body ? bodyId : '', options.detail ? detailId : ''].filter(Boolean).join(' ') || undefined

  return (
    <div
      className="ui-confirm-scrim"
      onMouseDown={(event) => {
        /* 只有点在遮罩本身才取消；从面板里拖出来松手不误关 */
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="ui-confirm"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        aria-describedby={describedBy}
        data-testid="confirm-dialog"
      >
        <div className="ui-confirm-head">
          <span className="ui-confirm-title">{options.title}</span>
          {queued > 0 ? <span className="ui-confirm-queued">{t('ui.confirmQueued', { n: queued })}</span> : null}
        </div>
        {options.body ? <div className="ui-confirm-body" id={bodyId}>{options.body}</div> : null}
        {options.detail ? <div className="ui-confirm-detail" id={detailId}>{options.detail}</div> : null}
        <div className="ui-confirm-foot">
          {/* DOM 顺序：取消在前 —— 焦点陷阱的初始焦点落在它上面，Enter 只会取消 */}
          <Button onClick={close} data-testid="confirm-cancel">{options.cancelLabel ?? t('ui.cancel')}</Button>
          <span className="spacer" />
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} data-testid="confirm-ok" onClick={() => queue.settle(request.id, true)}>
            {options.confirmLabel ?? t('ui.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
