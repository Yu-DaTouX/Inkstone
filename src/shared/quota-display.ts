export interface QuotaRenderInput {
  provider: string
  loading: boolean
  supported: boolean | null
  hasError: boolean
  hasMainText: boolean
  windowCount: number
  hasBudget: boolean
}

export function shouldRenderQuotaSection(input: QuotaRenderInput): boolean {
  if (!input.provider) return false
  if (input.supported === false) return false
  if (input.loading) return true
  if (input.hasError || input.hasMainText || input.windowCount > 0 || input.hasBudget) return true
  return input.supported === true
}

export function quotaSnapshotMatchesProvider(
  snapshotProvider: string | undefined,
  provider: string
): boolean {
  if (!snapshotProvider) return false
  return snapshotProvider.trim().toLowerCase() === provider.trim().toLowerCase()
}
