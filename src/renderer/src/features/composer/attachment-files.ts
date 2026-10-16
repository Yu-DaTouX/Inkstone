import type { Attachment } from '../../../../shared/ipc'

export async function readFiles(files: File[], add: (a: Attachment[]) => void, skipped?: (names: string[]) => void): Promise<void> {
  const rejected: string[] = []
  const out: Attachment[] = []
  for (const f of files) {
    if (f.size > 12 * 1024 * 1024) { rejected.push(f.name || 'pasted.png'); continue }
    try {
      const buf = await f.arrayBuffer()
      if (buf.byteLength > 12 * 1024 * 1024) { rejected.push(f.name || 'pasted.png'); continue }
      const data = bytesToBase64(new Uint8Array(buf))
      out.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name || 'pasted.png',
        mimeType: f.type || 'image/png',
        size: f.size,
        data,
        preview: data
      })
    } catch {
      rejected.push(f.name || 'pasted.png')
    }
  }
  add(out)
  if (rejected.length) skipped?.(rejected)
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
