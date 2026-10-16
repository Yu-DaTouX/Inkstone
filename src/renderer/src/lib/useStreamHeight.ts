import { useEffect, useRef, type RefObject } from 'react'

export function useStreamHeight(ref: RefObject<HTMLElement | null>): void {
  const bound = useRef<{ host: HTMLElement; stop: () => void } | null>(null)
  useEffect(() => {
    const host = ref.current
    if (bound.current?.host === host) return
    bound.current?.stop()
    bound.current = host ? { host, stop: track(host) } : null
  })
  useEffect(() => () => bound.current?.stop(), [])
}

function track(host: HTMLElement): () => void {
  let stream: HTMLElement | null = null
  let last = -1
  const write = (): void => {
    const h = stream?.clientHeight ?? 0
    if (h === last) return
    last = h
    if (h > 0) host.style.setProperty('--stream-h', `${h}px`)
    else host.style.removeProperty('--stream-h')
  }
  const resize = new ResizeObserver(write)
  const bind = (): void => {
    const next = host.matches('.stream') ? host : host.querySelector<HTMLElement>('.stream')
    if (next === stream) return
    if (stream) resize.unobserve(stream)
    stream = next
    if (stream) resize.observe(stream)
    write()
  }
  bind()
  const children = new MutationObserver(bind)
  if (host !== stream) children.observe(host, { childList: true })
  return () => {
    children.disconnect()
    resize.disconnect()
  }
}
