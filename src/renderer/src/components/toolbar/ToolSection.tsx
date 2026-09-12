import { createContext, useContext, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { ToolSectionId } from '../../../../shared/ipc'

/**
 * 工具栏分区的**外观**（可折叠的头 + body）。
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
  todo: 'rp.todo',
  queue: 'rp.queue',
  files: 'rp.files',
  ext: 'rp.ext',
  log: 'rp.log',
  actions: 'rp.actions'
}

export function Section({
  titleKey,
  extra,
  defaultOpen = true,
  testId,
  handle,
  children
}: {
  titleKey: MessageKey
  extra?: React.ReactNode
  defaultOpen?: boolean
  testId?: string
  /** 显式传把手（不传则用 context 里的） */
  handle?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const t = useT()
  const ctxHandle = useSectionHandle()
  const grip = handle ?? ctxHandle

  return (
    <section className={`rp-sec ${open ? 'open' : ''}`} data-sec={testId} data-testid={testId}>
      <div className="rp-sec-row">
        {grip}
        <button className="rp-sec-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Icon name="chevron-right" size={12} className="chev" />
          <span className="rp-sec-title">{t(titleKey)}</span>
          <span className="spacer" />
          {extra}
        </button>
      </div>
      {open ? <div className="rp-sec-body">{children}</div> : null}
    </section>
  )
}
