export type ApiResult =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; code: string; message: string; timedOut?: boolean; body?: string }

export function httpErrorCode(status: number): 'api_key_rejected' | 'rate_limited' | 'http_error' {
  if (status === 401 || status === 403) return 'api_key_rejected'
  if (status === 402 || status === 429 || status === 432 || status === 433) return 'rate_limited'
  return 'http_error'
}

export function httpErrorMessage(label: string, status: number): string {
  const code = httpErrorCode(status)
  if (code === 'api_key_rejected') return `${label} 拒绝了这个 API key（无效或没有权限）`
  if (code === 'rate_limited') return `${label} 请求过于频繁或额度用尽（HTTP ${status}）`
  return `${label} 返回 HTTP ${status}`
}

export async function callApi(
  label: string,
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  passStatuses: readonly number[] = []
): Promise<ApiResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal, redirect: 'manual' })
    const text = await res.text()
    if (res.ok || passStatuses.includes(res.status)) return { ok: true, status: res.status, text }
    return { ok: false, status: res.status, code: httpErrorCode(res.status), message: httpErrorMessage(label, res.status), body: text }
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, code: 'timeout', message: `超过 ${timeoutMs}ms 没有返回`, timedOut: true }
    }
    return { ok: false, code: 'network_error', message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
