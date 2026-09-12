import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { PANEL_MAX, PANEL_MIN, RAIL_MAX, RAIL_MIN } from '../../../shared/ipc'

/**
 * 面板宽度的拖拽把手。
 *
 * ── 三个设计决定 ──
 * ① **拖动中直接改 CSS 变量，松手才落盘。**
 *    每移动一像素就 patchSettings 会变成「每帧写一次文件」，
 *    而且 IPC 往返会让拖拽掉帧。所以拖动期间只改 DOM 上的变量（同步、零延迟），
 *    pointerup 时写一次设置。
 * ② **拖动中关掉 grid 的宽度过渡**。`.workspace` 有
 *    `transition: grid-template-columns 200ms` —— 那是给「收起/展开」
 *    用的动画；拖动时带着 200ms 缓动会让面板像被橡皮筋拽着走。
 * ③ **双击复原**，并且把手是**可聚焦的 separator**（方向键 ±8px，
 *    Shift ±24px）—— 鼠标拖拽对键盘用户不可用，这类「只能拖」的控件
 *    是无障碍上最容易漏的一类。
 *
 * 数值约定：0 = 用设计默认宽度（见 AppSettings.railWidth 的注释）。
 */
export function Resizer({ side }: { side: 'rail' | 'panel' }) {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  /*
   * ⚠️ 选择器**必须返回已有引用**，不能在里面造函数。
   *    上一版写的是 `useStore((s) => () => s.setRailPinned(false))` ——
   *    每帧返回一个新函数，zustand v5（useSyncExternalStore + Object.is）
   *    会认为状态一直在变 → **无限重渲染 → 整个界面空白**。
   *    实测就是靠探针发现的（“窗口控制按钮 0 个”）。
   */
  const setRailPinned = useStore((s) => s.setRailPinned)
  const toggleRightPanel = useStore((s) => s.toggleRightPanel)
  const toggleCollapse = useCallback((): void => {
    if (side === 'rail') setRailPinned(false)
    else void toggleRightPanel()
  }, [side, setRailPinned, toggleRightPanel])

  const stored = (side === 'rail' ? settings?.railWidth : settings?.panelWidth) ?? 0
  /** 拖动中的宽度（临时覆盖 stored，松手后清掉） */
  const [dragging, setDragging] = useState<number | null>(null)
  const startRef = useRef<{ x: number; base: number } | null>(null)

  /**
   * 拖到多窄就**直接收起**（用户要求：「拖拽到更窄的范围时直接收起」）。
   *
   * 为什么是「收起」而不是「继续变窄」：宽到 220px 以下时内容已经
   * 挤到不能用（中文标题一行放不下两个字），拖出来的也是个废面板。
   * 比「夹在 220px」更好的行为是：到了临界就归位（收起），意图很清楚。
   *
   * 注意这个值比 RAIL_MIN/PANEL_MIN（220）小 —— 拖到中间那一段是
   * 「继续缩小」的正常行为，只有超出最小宽再拖这么多才收起。
   */
  const COLLAPSE_AT = 100

  /** 拖动中是否已经越过「收起」临界（松手时才真的收起，避免拖回来时反复切） */
  const [willCollapse, setWillCollapse] = useState(false)

  const cssVar = side === 'rail' ? '--w-rail-user' : '--w-panel-user'
  /* 与主进程同一份区间（shared）。拖动时也得夹 —— 见 clamp 的注释 */
  const [min, max] = side === 'rail' ? [RAIL_MIN, RAIL_MAX] : [PANEL_MIN, PANEL_MAX]
  /**
   * 夹到合法区间。
   *
   * ⚠️ 渲染端也夹是必需的（不只是防御）：拖到极限时会产生 `-9439px`
   * 这种值，而 `grid-template-columns: -9439px` 是**非法声明**，
   * 浏览器会整条丢弃 —— 表现为「这一拖完全没反应」，而且
   * 落盘时读回CSS变量又变成 NaN，最后保存了个旧值。
   */
  const clamp = useCallback((w: number): number => Math.round(Math.min(max, Math.max(min, w))), [min, max])
  /** 从 CSS 变量读出当前实际宽度（没设置过就是设计默认值） */
  const readCurrent = useCallback((): number => {
    const el = document.documentElement
    const v = getComputedStyle(el).getPropertyValue(cssVar).trim()
    const n = parseFloat(v)
    if (Number.isFinite(n) && n > 0) return n
    // 兜底：从真实布局里量（变量没定义时）
    const sel = side === 'rail' ? '.rail' : '.rightpanel'
    const box = document.querySelector(sel)?.getBoundingClientRect().width
    return box && box > 0 ? Math.round(box) : side === 'rail' ? 300 : 264
  }, [cssVar, side])

  const apply = useCallback(
    (w: number) => {
      document.documentElement.style.setProperty(cssVar, `${w}px`)
    },
    [cssVar]
  )

  /** 开始拖：记录起点；用 pointer capture，指针移出窗口也不会丢 */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const base = readCurrent()
    startRef.current = { x: e.clientX, base }
    setDragging(base)
    /*
     * ⚠️ 先置状态再 capture，且 capture 必须容错 ——
     *    setPointerCapture 会抛 NotFoundError（指针已不存在时），
     *    不包 catch 的话异常会打断后面所有初始化，拖拽静默失效。
     *    分区排序那边就是这么错的（探针抓出来的）。
     */
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 拿不到 capture 也能拖 */
    }
    /*
     * 拖动期间禁掉过渡与文字选择。
     * user-select 尤其重要 —— 不关的话拖快了会把界面文字整片选蓝。
     */
    document.body.classList.add('resizing')
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = startRef.current
    if (!st) return
    // 左栏往右拖变宽；工具栏往左拖变宽 —— 所以工具栏要取反
    const dx = e.clientX - st.x
    const raw = side === 'rail' ? st.base + dx : st.base - dx
    /*
     * 拖到临界以下：不继续缩（保持最小宽），但记下「松手要收起」
     * 并给一个视觉反馈（把手变强调色 + 后缩一点），让用户知道
     * 再松手就会收起 —— 否则「松手后面板消失」会很突然。
     */
    if (raw < COLLAPSE_AT) {
      setWillCollapse(true)
      setDragging(min)
      apply(min)
      return
    }
    setWillCollapse(false)
    const next = clamp(raw)
    setDragging(next)
    apply(next)
  }

  const finish = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = startRef.current
    if (!st) return
    startRef.current = null
    const collapseNow = willCollapse
    setWillCollapse(false)
    setDragging(null)
    document.body.classList.remove('resizing')
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已经没了也无所谓 */
    }
    /*
     * 越过临界：**收起**，而且不把最小宽写进设置 ——
     * 用户要的是「收起」，不是「变成最窄」。设置保持原值（0 = 默认），
     * 下次展开时宽度回到他上次用的值。
     */
    if (collapseNow) {
      document.documentElement.style.removeProperty(cssVar)
      void toggleCollapse()
      return
    }
    // 落盘（主进程会再夹一次范围）
    const final = readCurrent()
    void setPanelWidth(side === 'rail' ? { railWidth: final } : { panelWidth: final })
  }

  /** 双击复原：把变量删掉 → 回到 CSS 里的设计默认值 */
  const reset = (): void => {
    document.documentElement.style.removeProperty(cssVar)
    void setPanelWidth(side === 'rail' ? { railWidth: 0 } : { panelWidth: 0 })
  }

  /** 键盘：方向键调宽窄（可聚焦的 separator） */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 24 : 8
    // 左栏：右箭头变宽；工具栏：左箭头变宽（方向与视觉一致）
    const widen = side === 'rail' ? 'ArrowRight' : 'ArrowLeft'
    const narrow = side === 'rail' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key !== widen && e.key !== narrow && e.key !== 'Home') return
    e.preventDefault()
    if (e.key === 'Home') {
      reset()
      return
    }
    const cur = readCurrent()
    const next = clamp(e.key === widen ? cur + step : cur - step)
    apply(next)
    void setPanelWidth(side === 'rail' ? { railWidth: next } : { panelWidth: next })
  }

  /*
   * 设置里换了宽度（比如另一个窗口改的 / 启动时读盘）→ 同步到 CSS 变量。
   * 拖动中不要跟 —— 否则会与手指的位置打架。
   */
  useEffect(() => {
    if (dragging !== null) return
    if (stored > 0) document.documentElement.style.setProperty(cssVar, `${stored}px`)
    else document.documentElement.style.removeProperty(cssVar)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, cssVar])

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      title={t('rp.resizeHint')}
      aria-label={t('rp.resizeHint')}
      data-testid={`resizer-${side}`}
      data-dragging={dragging !== null ? '1' : '0'}
      data-will-collapse={willCollapse ? '1' : '0'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}
