export type ControlSize = 'micro' | 'xs' | 'sm' | 'md'

export const CLOSE_ICON_SIZE: Readonly<Record<ControlSize, number>> = {
  micro: 12,
  xs: 12,
  sm: 12,
  md: 14
}

export const CONTROL_ICON_SIZE: Readonly<Record<ControlSize, number>> = {
  micro: 12,
  xs: 12,
  sm: 14,
  md: 16
}

export type SpinnerSizeName = 'xs' | 'sm' | 'md' | 'lg'

export const SPINNER_SIZE: Readonly<Record<SpinnerSizeName, number>> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20
}

export const CHEVRON_ICON_SIZE = 12
