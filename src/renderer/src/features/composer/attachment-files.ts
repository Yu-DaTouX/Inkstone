import type { Attachment } from '../../../../shared/ipc'

export async function readFiles(files: File[], add: (a: Attachment[]) => void, skipped?: (names: string[]) => void): Promise<void> {
  const rejected: string[] = []
  const out: Attachment[] = []
  for (const f of files) {
    if (f.size > 12 * 1024 * 1024) { rejected.push(f.name || 'pasted.png'); continue }
    try {
      const data = await readFileAsBase64(f)
      if (data === null) { rejected.push(f.name || 'pasted.png'); continue }
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

function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma < 0 ? null : result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.onabort = () => reject(new Error('file read aborted'))
    reader.readAsDataURL(file)
  })
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
