export const PASTED_TEXT_ATTACH_BYTES = 32 * 1024
export const PASTED_TEXT_MAX_BYTES = 50 * 1024 * 1024

export type SavedPastedText =
  | { ok: true; path: string; name: string; bytes: number }
  | { ok: false; error: 'empty' | 'too_large' | 'write' }

const NAME = /^pasted-text(?:-(\d{1,4}))?\.txt$/i

export function isPastedTextName(name: string): boolean {
  return NAME.test(name)
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function pastedTextShouldAttach(text: string, bypass: boolean): boolean {
  if (bypass || !text) return false
  return text.length >= PASTED_TEXT_ATTACH_BYTES || utf8Bytes(text) >= PASTED_TEXT_ATTACH_BYTES
}

export function nextPastedTextName(existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()))
  if (!taken.has('pasted-text.txt')) return 'pasted-text.txt'
  for (let n = 2; n < 10000; n += 1) {
    const name = `pasted-text-${n}.txt`
    if (!taken.has(name)) return name
  }
  return 'pasted-text.txt'
}

export function isPasteAsTextShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): boolean {
  if (event.key.toLowerCase() !== 'v' || !event.shiftKey || event.altKey) return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
