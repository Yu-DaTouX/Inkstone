import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 模态层（对话框 / 设置面板 / 确认框）的统一基座。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决三类过去靠各写一份、因此不一致的问题
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **全局快捷键抢按键** —— Shift+Tab / Ctrl+P 是主进程用
 *    `before-input-event` 拦的（先于渲染端），所以设置面板里的表单
 *    永远做不了反向焦点导航。这里维护一个模态栈，栈非空时上报
 *    主进程暂停拦截（`window.yan.setHotkeyGuard`）。
 *
 * ② **焦点圈定** —— 弹窗打开后 Tab 能跑到背后的界面上，键盘用户会
 *    迷失；关闭后焦点掉到 body，得从头 Tab 一遍。这里负责：打开时
 *    把焦点移进来、Tab 循环、关闭时还给打开它的那个元素。
 *
 * ③ **多层叠加** —— 两个弹窗同时在（比如设置面板上弹一个扩展确认框）时，
 *    Esc 只该关掉最上面那层，而不是一次关两个。`isTop` 就是这个判断。
 *
 * ⚠️ 有意**不**接管 role="dialog" / aria-modal 这些属性：各弹窗的
 *    DOM 结构差异很大（`.settings` / `.modal` / `.ob-card`），
 *    硬套一层 wrapper 会牵动大量既有 CSS。这里只做「行为」，
 *    属性仍由调用方写在它自己的面板元素上。
 */

/** 模态栈，先进后出。token 用于区分不同的调用方 */
const stack: symbol[] = []
const subs = new Set<() => void>()

/** 上报给主进程的缓存值 —— 状态没变就不重复 send */
let reported = false

function report(): void {
  const paused = stack.length > 0
  if (paused === reported) return
  reported = paused
  try {
    // 旧版 preload / 单元测试环境里可能没有这个方法
    const bridge = window.yan as unknown as { setHotkeyGuard?: (p: boolean) => void } | undefined
    bridge?.setHotkeyGuard?.(paused)
  } catch {
    /* 上报失败不能影响弹窗本身 */
  }
}

function sync(): void {
  report()
  for (const f of subs) f()
}

export function pushModal(token: symbol): void {
  if (stack.includes(token)) return
  stack.push(token)
  sync()
}

export function popModal(token: symbol): void {
  const i = stack.indexOf(token)
  if (i < 0) return
  stack.splice(i, 1)
  sync()
}

/** 当前是否有模态层打开。App.tsx 的兜底快捷键监听用它放行 */
export function isModalOpen(): boolean {
  return stack.length > 0
}

/** 是不是最上面那层 —— 只有它该响应 Esc */
export function isTopModal(token: symbol): boolean {
  return stack[stack.length - 1] === token
}

/**
 * 声明「这个组件开着的时候是一层模态」。
 *
 * @param open  该层是否打开（用组件自己的 open / 挂载状态）
 * @param onClose 顶层时按 Esc 的回调；不传则不接管 Esc
 * @returns isTop —— Esc / 快捷键这类「只归最上层」的逻辑用它判断
 */
export function useModalLayer(open: boolean, onClose?: () => void): { isTop: boolean } {
  const tokenRef = useRef<symbol | null>(null)
  if (tokenRef.current === null) tokenRef.current = Symbol('yan-modal')
  const token = tokenRef.current

  const [, force] = useState(0)

  /* 栈变化时重算 isTop（自己 push/pop 也要重新渲染，所以订阅） */
  useEffect(() => {
    const f = (): void => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    pushModal(token)
    return () => popModal(token)
  }, [open, token])

  const isTop = open && isTopModal(token)

  /*
   * onClose 放 ref：调用方大多写成内联箭头函数（每次渲染都是新引用），
   * 直接进依赖数组会让监听器反复解绑/重绑。行为上无害但没必要。
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  /* Esc：只关最上面那层 */
  useEffect(() => {
    if (!isTop || !closeRef.current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current?.()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [isTop])

  return { isTop }
}

/**
 * 可获得焦点的元素选择器。
 * 排除 `tabindex="-1"`（那是有意不参与 Tab 遍历的）。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex !== -1 &&
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      // 不可见的（display:none / 0 尺寸）不该进 Tab 序列
      el.getClientRects().length > 0
  )
}

/**
 * 焦点陷阱 + 焦点恢复。
 *
 * - 打开时：如果焦点不在容器内（例如没有 autoFocus），移进去
 * - Tab / Shift+Tab：在容器内循环，不会跑到背后的界面
 * - 关闭 / 卸载时：焦点还给「打开它的那个元素」
 *
 * ⚠️ `open` 与 `top` 必须分开，它们回答的是两个不同的问题：
 *   · open —— 这层**开着**\uff08决定记录/恢复焦点）
 *   · top  —— 这层是**最上层**（决定要不要接管 Tab）
 *   合在一起会错：上层弹窗弹出时，下层只是「不再最上层」而不是
 *   「关闭」，那时把焦点还给外部会把它从上层弹窗里拉出来。
 *
 * ⚠️ `open` 要传「DOM 已存在」的那个值（如 usePresence 的 mounted），
 *   而不是组件自己的 open —— 否则 effect 会在节点挂上之前跑一次，
 *   `ref.current` 是 null，整个陷阱（包括初始焦点）就静默地什么都没做。
 *
 * @param ref  容器元素（面板本身，不含遮罩）
 * @param open 该层是否打开（DOM 已挂载）
 * @param top  该层是否最上层
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  top: boolean
): void {
  const restoreRef = useRef<HTMLElement | null>(null)

  /* 打开期间：记录来源 + 初始焦点；关闭 / 卸载：还回去 */
  useEffect(() => {
    if (!open) return
    const root = ref.current
    if (!root) return

    /*
     * 记住「是谁打开的」。
     * body / html 不算 —— 那样恢复焦点等于什么都没做。
     */
    const prev = document.activeElement as HTMLElement | null
    restoreRef.current = prev && prev !== document.body && document.contains(prev) ? prev : null

    /* 初始焦点：容器里已有 autoFocus 就不抢（否则会打断它的定位） */
    let cancelInitial: (() => void) | undefined
    if (!root.contains(document.activeElement)) {
      const raf = requestAnimationFrame(() => {
        if (root.contains(document.activeElement)) return
        focusablesIn(root)[0]?.focus()
      })
      /* 清理时要取消，避免弹窗已关还去抢焦点 */
      cancelInitial = () => cancelAnimationFrame(raf)
    }

    return () => {
      cancelInitial?.()
      const to = restoreRef.current
      restoreRef.current = null
      if (to && document.contains(to) && typeof to.focus === 'function') to.focus()
    }
  }, [ref, open])

  /* Tab 圈定：只有最上层接管 */
  useEffect(() => {
    if (!open || !top) return
    const root = ref.current
    if (!root) return

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const list = focusablesIn(root)
      if (list.length === 0) {
        // 没有可聚焦元素：别让 Tab 把焦点带到背后去
        e.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const cur = document.activeElement as HTMLElement | null
      const inside = !!cur && root.contains(cur)

      if (e.shiftKey) {
        if (!inside || cur === first) {
          e.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || cur === last) {
        e.preventDefault()
        first.focus()
      }
    }

    /* 用 document 捕获：焦点万一跑到容器外，也能把它拉回来 */
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ref, open, top])
}
