import { useEffect, useState, type ComponentPropsWithRef, type JSX } from 'react'

const INLINE_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,/i

export function inlineImageObjectUrl(src: string): string | null {
  const match = INLINE_IMAGE.exec(src)
  if (!match) return null
  try {
    const binary = atob(src.slice(match[0].length))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: match[1] }))
  } catch {
    return null
  }
}

export function InlineImage({ src, ...props }: ComponentPropsWithRef<'img'>): JSX.Element {
  const inline = typeof src === 'string' && INLINE_IMAGE.test(src)
  const [owned, setOwned] = useState<{ source: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!src || !INLINE_IMAGE.test(src)) {
      setOwned(null)
      return
    }
    const url = inlineImageObjectUrl(src)
    setOwned({ source: src, url })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [src])
  const displaySrc = inline ? owned?.source === src ? owned.url ?? undefined : undefined : src
  return <img {...props} src={displaySrc} />
}
