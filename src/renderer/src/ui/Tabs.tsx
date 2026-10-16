import { useEffect, useRef } from 'react'
import {
  Tab as RACTab,
  TabList as RACTabList,
  TabPanel as RACTabPanel,
  TabPanels,
  Tabs as RACTabs,
  composeRenderProps,
  type TabListProps as RACTabListProps,
  type TabPanelProps as RACTabPanelProps,
  type TabProps as RACTabProps,
  type TabsProps as RACTabsProps
} from 'react-aria-components'
import { X } from 'lucide-react'
import { cx } from './cx'

export { TabPanels }
export type TabsProps = RACTabsProps
export type TabListProps<T extends object = object> = RACTabListProps<T>
export type TabPanelProps = RACTabPanelProps

/** 页签容器。键盘左右键在页签间移动，`Tab` 进入面板。 */
export function Tabs({ className, ...props }: TabsProps) {
  return <RACTabs {...props} className={composeRenderProps(className, (cn) => cx('ui-tabs', cn))} />
}

export function TabList<T extends object = object>({ className, ...props }: TabListProps<T>) {
  return <RACTabList {...props} className={composeRenderProps(className, (cn) => cx('ui-tablist', cn))} />
}

export interface TabProps extends RACTabProps {
  /** 提供后，页签右侧出现独立的关闭按钮。 */
  onClose?: () => void
  /** 关闭按钮的读屏名称，默认「关闭」。 */
  closeLabel?: string
}

/**
 * 页签。
 *
 * 设计修复（对应 v2.0 I-01）：**切换与关闭是两个独立的按钮**。外层页签只负责
 * 切换；关闭是右侧一个单独的 `role="button"`（`tabIndex=-1`，不额外占用 Tab
 * 顺序），指针事件与点击都被拦下，不会连带切换页签。
 *
 * RAC 的 `TabProps` 没有暴露 `onKeyDown`，可关闭页签的键盘约定（焦点在页签上
 * 按 `Delete` / `Backspace` 关闭）用原生监听器补上，不干扰 RAC 的方向键导航。
 */
export function Tab({ onClose, closeLabel = '关闭', className, children, ...props }: TabProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node || !onClose) return
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        onClose()
      }
    }
    node.addEventListener('keydown', handler)
    return () => node.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <RACTab {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-tab', cn))}>
      {composeRenderProps(children, (kids) => (
        <>
          <span className="ui-tab__label">{kids}</span>
          {onClose ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={closeLabel}
              className="ui-tab__close"
              onPointerDown={(event) => {
                event.stopPropagation()
                event.preventDefault()
              }}
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                onClose()
              }}
            >
              <X size={13} aria-hidden="true" />
            </span>
          ) : null}
        </>
      ))}
    </RACTab>
  )
}

/** 页签对应的面板。没有选中页签时不挂载。 */
export function TabPanel({ className, ...props }: TabPanelProps) {
  return <RACTabPanel {...props} className={composeRenderProps(className, (cn) => cx('ui-tabpanel', cn))} />
}
