import { useEffect, useRef } from 'react'
import {
  SelectionIndicator,
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
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { CLOSE_ICON_SIZE } from './sizes'

export { TabPanels }
export type TabsProps = RACTabsProps
export type TabListProps<T extends object = object> = RACTabListProps<T>
export type TabPanelProps = RACTabPanelProps

export function Tabs({ className, ...props }: TabsProps) {
  return <RACTabs {...props} className={composeRenderProps(className, (cn) => cx('ui-tabs', cn))} />
}

export function TabList<T extends object = object>({ className, ...props }: TabListProps<T>) {
  return <RACTabList {...props} className={composeRenderProps(className, (cn) => cx('ui-tablist', cn))} />
}

export interface TabProps extends RACTabProps {
  onClose?: () => void
  closeLabel?: string
}

export function Tab({ onClose, closeLabel, className, children, ...props }: TabProps) {
  const t = useOptionalT()
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
          <SelectionIndicator className="ui-tab__ink" />
          <span className="ui-tab__label">{kids}</span>
          {onClose ? (
            <span
              aria-hidden="true"
              title={closeLabel ?? t('ui.close')}
              className="ui-tab__close"
              onPointerDown={(event) => {
                event.stopPropagation()
                event.preventDefault()
              }}
              onClick={(event) => {
                event.stopPropagation()
                onClose()
              }}
            >
              <X size={CLOSE_ICON_SIZE.micro} />
            </span>
          ) : null}
        </>
      ))}
    </RACTab>
  )
}

export function TabPanel({ className, ...props }: TabPanelProps) {
  return <RACTabPanel {...props} className={composeRenderProps(className, (cn) => cx('ui-tabpanel', cn))} />
}
