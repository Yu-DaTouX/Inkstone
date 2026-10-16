export interface YanBuildInfo {
  version: string
  buildTime: string
  buildHash: string
  repositoryUrl: string
}

declare const __YAN_BUILD__: YanBuildInfo

export const BUILD_INFO: YanBuildInfo =
  typeof __YAN_BUILD__ === 'undefined'
    ? { version: '', buildTime: '', buildHash: '', repositoryUrl: '' }
    : __YAN_BUILD__

export function normalizeRepositoryUrl(raw: string | undefined | null): string {
  if (!raw) return ''
  return raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/#.*$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

export function formatBuildTime(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}
