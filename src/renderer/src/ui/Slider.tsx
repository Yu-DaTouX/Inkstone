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
  /** 可见标签，与 `aria-label` 二选一；范围值时为两手柄共用。 */
  label?: ReactNode
  /** 标签下方的说明，经 `aria-describedby` 关联到手柄输入。 */
  description?: ReactNode
  /** 错误文案；出现即视为无效，经 `aria-errormessage` 关联到手柄输入。 */
  errorMessage?: ReactNode
  /** 单独标记无效而没有错误文案时使用。 */
  isInvalid?: boolean
  /** 在轨道右侧显示当前值（范围值显示两端）。 */
  showValue?: boolean
  /**
   * 范围滑块每个手柄的可读名称，按值顺序对应。
   * 单一滑块留空即可，名称来自 `label` / `aria-label`。
   */
  thumbLabels?: string[]
  /** 自定义结构时使用；留空走默认标签 + 轨道 + 值。 */
  children?: ReactNode | ((values: SliderRenderProps) => ReactNode)
  /** RAC 的根元素不接收该属性，这里转发到手柄 `<input>`。 */
  'aria-errormessage'?: string
}

/**
 * 滑杆：在连续或分档区间里选一个值（`value: number`）或一段范围（`value: number[]`）。
 *
 * 受控用 `value` + `onChange`，非受控用 `defaultValue`；键盘、拖动、点击轨道与焦点
 * 全部由 React Aria Components 的滑杆状态机处理，本组件只补标签、值、说明、错误和
 * 轨道/手柄外观。`minValue` / `maxValue` / `step` / `formatOptions` 原样透传。
 */
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
