let sink: ((message: string) => void) | null = null
const shown = new Set<string>()

export function setPersistedNoticeSink(next: ((message: string) => void) | null): void {
  sink = next
}

export function noticeNewerVersionFile(kind: string, message: string): void {
  if (!sink || shown.has(kind)) return
  shown.add(kind)
  sink(message)
}
