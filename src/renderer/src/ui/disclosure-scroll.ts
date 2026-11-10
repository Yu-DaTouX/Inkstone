export function revealCollapsedHeader(head: HTMLElement | null): void {
  const stream = head?.closest<HTMLElement>('.v3-stream')
  if (!head || !stream || head.getBoundingClientRect().top >= stream.getBoundingClientRect().top) return
  requestAnimationFrame(() => {
    if (!head.isConnected || head.getAttribute('aria-expanded') !== 'false') return
    stream.scrollTop += head.getBoundingClientRect().top - stream.getBoundingClientRect().top
  })
}
