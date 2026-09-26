import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { IconName } from '../../icons/sprite'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { ToolSectionId } from '../../../../shared/ipc'

/**
 * 工具栏分区的**外观**（卡片：可折叠的头 + body）。
 *
 * 为什么单独一个模块：一个分区需要同时被两方了解 ——
 *   · 容器（RightPanel）知道「顺序、谁被收进库了」，负责把把手塞进去
 *   · 分区自己（ContextSection / FileTree …）知道标题、头部附加信息、内容
 * 把「长什么样」放这里，两边都能用且**不互相 import**（之前 FileTree 直接
 * 从 RightPanel 拿 Section，会形成循环依赖）。
 *
 * 把手通过 **context** 传给分区，而不是当 prop 传：
 *   分区组件是在注册表里被调用的（`() => <FileTree />`），
 *   如果要求每个分区都接一个 handle prop，注册表就得到处透传，
 *   而且 FileTree 那种自己带子组件的会更难办。
 */
const HandleCtx = createContext<React.ReactNode>(null)

/** 容器用来把排序把手注入下面所有分区 */
export const HandleProvider = HandleCtx.Provider
export const useSectionHandle = (): React.ReactNode => useContext(HandleCtx)

/**
 * 分区 id → 标题键。
 * 放在这里而不是各文件自己写一份：工具栏渲染与工具库列表都要显示标题，
 * 两处各写一份迟早会出现「同一块在两处叫不同名字」。
 */
export const SECTION_TITLE: Record<ToolSectionId, MessageKey> = {
  context: 'rp.context',
  quota: 'rp.quota',
  todo: 'rp.todo',
  queue: 'rp.queue',
  files: 'rp.files',
  ext: 'rp.ext',
  log: 'rp.log',
  actions: 'rp.actions'
}

/**
 * 分区 id → 图标，供**拖动预览**使用（卡片标题前已不再画图标）。
 *
 * 用户：「移除图标并把标题都变小一些」—— 标题前的图标格 + gap 共 24px，
 * 右栏拖窄后会把标题挤成「上下…」。拖动预览不占排版宽度，图标留着有用。
 */
/**
 * 工具分区的标题图标。
 *
 * 实施-24 I0：**额度不再借用 `layers`** —— 盘点时发现 `layers` 同时表示
 * 「会话地图 / 分支 / 分组 / 环境 / 磁贴」，再拿它当额度图标只会加重歧义；
 * 而 DESIGN.md 本来就规定「额度只用标题文字」。上下文保留 `checklist`（清单语义）。
 */
export const SECTION_ICON: Partial<Record<ToolSectionId, IconName>> = {
  context: 'checklist'
}

export function Section({
  titleKey,
  extra,
  defaultOpen = true,
  compactWhenFloating = false,
  testId,
  handle,
  /** 受控展开态（不传则内部自管）。任务栏用它做「全部完成自动收起」 */
  open: openProp,
  onOpenChange,
  children
}: {
  titleKey: MessageKey
  extra?: React.ReactNode
  defaultOpen?: boolean
  /** 浮动后仍保留可展开的摘要（上下文与额度）。 */
  compactWhenFloating?: boolean
  testId?: string
  /** 显式传把手（不传则用 context 里的） */
  handle?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  const [openState, setOpenState] = useState(defaultOpen)
  const ctxHandle = useSectionHandle()
  const grip = handle ?? ctxHandle
  /* 普通磁贴浮动后直接展示内容；摘要磁贴保留原来的开合状态。 */
  const open = openProp ?? (grip === null && !compactWhenFloating ? true : openState)
  const setOpen = (v: boolean): void => {
    setOpenState(v)
    onOpenChange?.(v)
  }
  const t = useT()

  /**
   * 折叠 / 展开动画（2026-09-25）。
   *
   * 用 `grid-template-rows: 0fr ↔ 1fr` 而不是量 `scrollHeight`：内容高度
   * 自适应，额度、日志这类异步长出来的内容也不会把高度算错。
   *
   * 两个 state 分工：
   *   · `mounted`  折叠动画**结束后**才卸载内容。收起瞬间就卸掉的话没有收拢
   *                过程，而且屏幕阅读器与探针会读到「看不见的内容」——
   *                改造前收起态 body 根本不在 DOM 里，这个语义要保住。
   *   · `collapsedOnce` 只控制「展开时要不要播入场动画」：首屏默认展开的卡
   *                不该集体抖一下，用户收起过之后再展开才有动画。
   *
   * 展开**不走 transition 而走 animation**：内容刚挂载时只靠 transition 得
   * 「先渲染 0fr、下一帧再切 1fr」，而后台 / 无合成帧的窗口里 rAF 会被
   * 节流 —— 实测那种环境下展开会卡在 0 高度。animation 在元素首次渲染时
   * 就开跑，不依赖额外帧；收起方向内容已在 DOM 里，transition 正常工作。
   */
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  const [collapsedOnce, setCollapsedOnce] = useState(!open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    setCollapsedOnce(true)
    if (!mounted) return
    const el = bodyRef.current
    if (!el) {
      setMounted(false)
      return
    }
    /*
     * transitionend 会从子元素冒泡上来，所以先认 target；
     * 也因此不能写 { once: true } —— 冒泡来的第一个事件会把监听吃掉。
     * 定时器兜底：动效被系统关掉（时长 0）或过渡中途被打断时也要卸载。
     */
    const finish = (e: TransitionEvent): void => {
      if (e.target !== el) return
      el.removeEventListener('transitionend', finish)
      setMounted(false)
    }
    el.addEventListener('transitionend', finish)
    const timer = window.setTimeout(() => {
      el.removeEventListener('transitionend', finish)
      setMounted(false)
    }, 400)
    return () => {
      el.removeEventListener('transitionend', finish)
      window.clearTimeout(timer)
    }
  }, [open, mounted])

  return (
    <section className={`rp-sec ${open ? 'open' : ''} ${compactWhenFloating ? 'rp-summary-sec' : ''}`} data-sec={testId} data-testid={testId}>
      <div className="rp-sec-row">
        {grip}
        <button className="rp-sec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          {/*
           * 标题前不再放图标，也不放折叠箭头（用户：「移除图标并把标题都变小一些」）。
           *
           * 原来是「有 icon 画 16px 图标，否则画 12px 折叠箭头」，两者都占
           * 一格 + 一个 gap（共 24px）。右栏拖窄后这 24px 很贵 —— 标题会被
           * flex 压成「上下…」。左边本来就有拖拽柄，再排一个图标格更挤。
           *
           * 开合状态由 `.rp-sec-head[aria-expanded]`、整行可点与 `.rp-sec.open`
           * 展开动画给出 —— 不再为它占一行宽度。（不再画箭头是权衡：
           * 右栏拖窄时宽度比多一个提示更重要。）
           */}
          <span className="rp-sec-title">{t(titleKey)}</span>
          <span className="spacer" />
          {extra}
        </button>
      </div>
      <div
        ref={bodyRef}
        className={`rp-sec-body ${open ? 'open' : ''} ${open && collapsedOnce ? 'anim' : ''}`}
      >
        {mounted || open ? <div className="rp-sec-body-inner">{children}</div> : null}
      </div>
    </section>
  )
}
