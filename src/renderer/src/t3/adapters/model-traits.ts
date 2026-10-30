export type ProviderOptionChoice = {
  id: string
  label: string
  description?: string
  isDefault?: boolean
}

export type SelectDescriptor = {
  id: string
  label: string
  type: 'select'
  options: readonly ProviderOptionChoice[]
  currentValue: string | null
  promptInjectedValues?: readonly string[]
}

export type BooleanDescriptor = {
  id: string
  label: string
  type: 'boolean'
  currentValue: boolean
}

export type ProviderOptionDescriptor = SelectDescriptor | BooleanDescriptor

export const REASONING_SELECT_DESCRIPTOR_ID = 'reasoningEffort'

export const ULTRACODE_OPTION_ID = 'ultracode'

export type TraitsTriggerDisplay = {
  label: string
  speedLabel: null
  otherLabels: readonly string[]
}

export function isSelectDescriptor(
  descriptor: ProviderOptionDescriptor | null | undefined
): descriptor is SelectDescriptor {
  return descriptor?.type === 'select'
}

export function descriptorCurrentLabel(descriptor: SelectDescriptor | null): string | null {
  if (!descriptor || descriptor.currentValue === null) return null
  return (
    descriptor.options.find((option) => option.id === descriptor.currentValue)?.label ??
    descriptor.currentValue
  )
}

export function buildReasoningDescriptor(input: {
  levels: readonly string[]
  current: string
  ultracode: boolean
  ultracodeLabel: string
  ultracodeDescription: string
  sectionLabel: string
  levelLabel: (level: string) => string
}): SelectDescriptor | null {
  const levels = input.levels
  const ultracodeAvailable = levels.length > 1 && input.ultracodeLabel.length > 0
  if (levels.length <= 1) return null
  const options: ProviderOptionChoice[] = levels.map((level) => ({
    id: level,
    label: input.levelLabel(level)
  }))
  if (ultracodeAvailable) {
    options.push({
      id: ULTRACODE_OPTION_ID,
      label: input.ultracodeLabel,
      description: input.ultracodeDescription
    })
  }
  return {
    id: REASONING_SELECT_DESCRIPTOR_ID,
    label: input.sectionLabel,
    type: 'select',
    options,
    currentValue: input.ultracode ? ULTRACODE_OPTION_ID : input.current,
    ...(ultracodeAvailable ? { promptInjectedValues: [ULTRACODE_OPTION_ID] } : {})
  }
}

export function buildTraitsTriggerDisplay(descriptor: SelectDescriptor): TraitsTriggerDisplay {
  return {
    label: descriptorCurrentLabel(descriptor) ?? descriptor.label,
    speedLabel: null,
    otherLabels: []
  }
}

export function isUltracodeSelection(value: string): boolean {
  return value === ULTRACODE_OPTION_ID
}
