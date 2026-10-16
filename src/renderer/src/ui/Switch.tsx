import { forwardRef, type ReactNode } from 'react'
import {
  Switch as RACSwitch,
  composeRenderProps,
  type SwitchProps as RACSwitchProps
} from 'react-aria-components'
import { cx } from './cx'

export interface SwitchProps extends RACSwitchProps {
  children?: ReactNode
}

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
