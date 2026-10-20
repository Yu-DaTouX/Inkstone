export function siteLabelOf(origin: string): string {
  const withoutScheme = String(origin ?? '').replace(/^https?:\/\//i, '')
  return withoutScheme.replace(/\/+$/, '') || String(origin ?? '')
}
