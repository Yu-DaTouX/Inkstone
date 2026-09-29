import type { Attachment } from '../../../../shared/ipc'

/** 把 File 读成 base64 附件 */
export async function readFiles(files: File[], add: (a: Attachment[]) => void): Promise<void> {
  const out: Attachment[] = []
  for (const f of files) {
    if (f.size > 12 * 1024 * 1024) continue
    try {
      const buf = await f.arrayBuffer()
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
      /* 读不了就跳过 */
    }
  }
  add(out)
}

/** 不用 FileReader：它返回 data: 前缀，而 pi 要的是裸 base64 */
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
