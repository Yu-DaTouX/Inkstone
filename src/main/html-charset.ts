const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i

export function declaredHtmlCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const label = META_CHARSET.exec(head)?.[1]?.toLowerCase()
  if (!label) return null
  try {
    return new TextDecoder(label).encoding
  } catch {
    return null
  }
}

export function decodeHtml(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    const charset = declaredHtmlCharset(bytes)
    if (charset && charset !== 'utf-8') return new TextDecoder(charset).decode(bytes)
    return new TextDecoder('utf-8').decode(bytes)
  }
}
