export interface BrowserElement {
  ref: string
  role: string
  name: string
  box: [number, number, number, number]
  disabled?: boolean
  value?: string
  frameId?: string
  frameUrl?: string
  offscreen?: boolean
}

export interface RegisteredElement extends BrowserElement {
  backendNodeId: number
  sessionId?: string
  frameOffset?: [number, number]
}

export class StaleElementError extends Error {
  readonly code = 'STALE_ELEMENT'

  constructor(ref: string) {
    super(`元素引用已失效：${ref}。请重新调用 yan browser observe。`)
    this.name = 'StaleElementError'
  }
}

export class NotSelectElementError extends Error {
  readonly code = 'NOT_SELECT'

  constructor(ref: string, tag: string) {
    super(`元素 ${ref} 不是下拉框（<${tag || '?'}>）。下拉框才能用 select；文本框用 type，按钮用 click。`)
    this.name = 'NotSelectElementError'
  }
}

export class SelectOptionNotFoundError extends Error {
  readonly code = 'OPTION_NOT_FOUND'

  constructor(ref: string, wanted: string, options: string[]) {
    const list = options.slice(0, 20).join(' / ')
    super(
      `下拉框 ${ref} 里没有「${wanted}」。可选值：${list || '（空）'}${options.length > 20 ? ` …共 ${options.length} 个` : ''}`
    )
    this.name = 'SelectOptionNotFoundError'
  }
}

const TAG_LETTERS = 'bcdfghjkmnpqrstvwxz'
const usedTags = new Set<string>()

function freshTag(): string {
  if (usedTags.size > TAG_LETTERS.length ** 3 / 2) usedTags.clear()
  for (;;) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(3))
    const tag = [...bytes].map((byte) => TAG_LETTERS[byte % TAG_LETTERS.length]).join('')
    if (usedTags.has(tag)) continue
    usedTags.add(tag)
    return tag
  }
}

export class ElementRegistry {
  private readonly targetId = globalThis.crypto.randomUUID()
  private generation = 0
  private nextIndex = 1
  private readonly indexByNode = new Map<string, number>()
  private elements = new Map<string, RegisteredElement>()

  readonly tag: string

  constructor(tag?: string) {
    this.tag = tag ?? freshTag()
  }

  generationKey(): string {
    return `${this.targetId}:${this.generation}`
  }

  refresh(elements: Omit<RegisteredElement, 'ref'>[]): { generationId: string; refs: string[] } {
    const generationId = `${this.targetId}:${this.generation}`
    const next = new Map<string, RegisteredElement>()
    const refs = elements.map((element) => {
      const node = `${element.sessionId ?? ''}|${element.frameId ?? ''}|${element.backendNodeId}`
      let index = this.indexByNode.get(node)
      if (index === undefined) {
        index = this.nextIndex++
        this.indexByNode.set(node, index)
      }
      const ref = `${this.tag}${index}`
      next.set(ref, { ...element, ref })
      return ref
    })
    this.elements = next
    return { generationId, refs }
  }

  resolve(ref: unknown): RegisteredElement {
    const value = typeof ref === 'string' ? ref : ''
    const element = this.elements.get(value)
    if (!element) throw new StaleElementError(value || '<empty>')
    return { ...element }
  }

  clear(): void {
    this.generation += 1
    this.indexByNode.clear()
    this.elements.clear()
  }
}

