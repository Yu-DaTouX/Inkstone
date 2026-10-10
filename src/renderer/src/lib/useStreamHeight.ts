import { useEffect, useRef, type RefObject } from 'react'

/**
 * 把对话滚动区（.stream）的可见高度写到 `--stream-h`：并列过程栏 sticky 时用它封顶，
 * 不会比可见区高（否则栏底部的终端被截掉，滚不到）。
 *
 * ref 可以是 .stream 本身，也可以是包着它的列；列里的 .stream 会在普通列表与虚拟列表之间
 * 换节点，所以只观察列的直接子节点变化，不观察整棵树。分屏换焦点时列会重新挂载，
 * 每次渲染后比对一次 ref 指向的节点，变了才重新绑定。
 */
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
