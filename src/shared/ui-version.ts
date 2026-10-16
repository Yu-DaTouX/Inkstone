export type UiVersion = 'v2' | 'v3'

export function asUiVersion(value: unknown): UiVersion | null {
  return value === 'v2' || value === 'v3' ? value : null
}

export function resolveUiVersion(environment: unknown, setting: unknown): UiVersion {
  return asUiVersion(environment) ?? asUiVersion(setting) ?? 'v2'
}

export function uiVersionArgument(args: readonly string[]): UiVersion | null {
  if (args.includes('--yan-ui=v3')) return 'v3'
  if (args.includes('--yan-ui=v2')) return 'v2'
  return null
}
