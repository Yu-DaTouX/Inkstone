export type MessageLocator = (messageId: string) => Promise<boolean>

const HIGHLIGHT_MS = 1800
const REGISTER_WAIT_FRAMES = 12

let activeLocator: MessageLocator | null = null

export function registerMessageLocator(locator: MessageLocator): () => void {
  activeLocator = locator
  return () => {
    if (activeLocator === locator) activeLocator = null
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export function cssQuoted(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

export function highlightMessageElement(el: Element): void {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
  el.classList.add('msg-located')
  window.setTimeout(() => el.classList.remove('msg-located'), HIGHLIGHT_MS)
}

export async function locateMessageInView(messageId: string): Promise<boolean> {
  for (let frame = 0; !activeLocator && frame < REGISTER_WAIT_FRAMES; frame++) await nextFrame()
  return activeLocator ? activeLocator(messageId) : false
}
