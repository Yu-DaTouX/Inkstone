import { forwardRef, useId, type ReactNode } from 'react'
import {
  Label,
  Slider as RACSlider,
  SliderFill,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  composeRenderProps,
  type SliderProps as RACSliderProps,
  type SliderRenderProps
} from 'react-aria-components'
import { cx } from './cx'

export interface SliderProps extends Omit<RACSliderProps<number | number[]>, 'label' | 'children'> {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: ReactNode
  isInvalid?: boolean
  showValue?: boolean
  thumbLabels?: string[]
  children?: ReactNode | ((values: SliderRenderProps) => ReactNode)
  'aria-errormessage'?: string
}

export const Slider = forwardRef<HTMLDivElement, SliderProps>(function Slider(
  {
    label,
    description,
    errorMessage,
    isInvalid = false,
    showValue = false,
    thumbLabels,
    className,
    children,
    'aria-describedby': ariaDescribedBy,
    'aria-errormessage': ariaErrorMessage,
    ...props
  },
  ref
) {
  const descriptionId = useId()
  const errorId = useId()
  const invalid = isInvalid || errorMessage != null
  const describedBy =
    [description != null ? descriptionId : null, ariaDescribedBy ?? null].filter(Boolean).join(' ') || undefined
  const errorMessageId =
    [errorMessage != null ? errorId : null, ariaErrorMessage ?? null].filter(Boolean).join(' ') || undefined

  return (
    <RACSlider
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) =>
        cx('ui-slider', 'ui-field', invalid && 'ui-slider--invalid', cn)
      )}
    >
      {composeRenderProps(children, (kids, values) =>
        kids ?? (
          <>
            {label != null ? <Label className="ui-field__label">{label}</Label> : null}
            <div className="ui-slider__row">
              <SliderTrack className="ui-slider__track">
                <SliderFill className="ui-slider__fill" />
                {values.state.values.map((_, index) => (
                  <SliderThumb
                    key={index}
                    index={index}
                    className="ui-slider__thumb"
                    aria-label={thumbLabels?.[index]}
                    aria-describedby={describedBy}
                    aria-errormessage={errorMessageId}
                    isInvalid={invalid || undefined}
                  />
                ))}
              </SliderTrack>
              {showValue ? <SliderOutput className="ui-slider__value" /> : null}
            </div>
            {description != null ? (
              <span id={descriptionId} className="ui-field__desc">
                {description}
              </span>
            ) : null}
            {errorMessage != null ? (
              <span id={errorId} className="ui-field__error">
                {errorMessage}
              </span>
            ) : null}
          </>
        )
      )}
    </RACSlider>
  )
})
