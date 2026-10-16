import { forwardRef, type ReactNode } from 'react'
import {
  Switch as RACSwitch,
  composeRenderProps,
  type SwitchProps as RACSwitchProps
} from 'react-aria-components'
import { cx } from './cx'

export interface SwitchProps extends RACSwitchProps {
  /** 开关旁边的文字。 */
  children?: ReactNode
}

/**
 * 开关：用于「立即生效」的布尔设置。选项组内请用 `Radio`。
 * 轨道与滑块是纯展示，交互与 ARIA 由 RAC 处理。
 */
export const Switch = forwardRef<HTMLLabelElement, SwitchProps>(function Switch(
  { className, children, ...props },
  ref
) {
  return (
    <RACSwitch {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-switch', cn))}>
      {composeRenderProps(children, (kids) => (
        <>
          <span className="ui-switch__track" aria-hidden="true">
            <span className="ui-switch__thumb" />
          </span>
          {kids != null ? <span className="ui-switch__label">{kids}</span> : null}
        </>
      ))}
    </RACSwitch>
  )
})
