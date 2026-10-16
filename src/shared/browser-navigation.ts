export const ERR_ABORTED = -3

export interface BrowserLoadFailure {
  code: number
  description: string
  url: string
}

export function shouldSurfaceLoadError(errorCode: number, isMainFrame: boolean): boolean {
  if (!isMainFrame) return false
  return errorCode !== ERR_ABORTED
}

export function nextAddressInput(committed: string, draft: string, dirty: boolean): string {
  return dirty ? draft : committed
}

export function failureUrl(validatedUrl: string | undefined | null, fallback: string): string {
  const value = (validatedUrl ?? '').trim()
  return value || fallback
}

export function sameCommittedUrl(a: string, b: string): boolean {
  const trim = (value: string): string => value.replace(/\/+$/, '')
  return trim(a ?? '') === trim(b ?? '')
}
