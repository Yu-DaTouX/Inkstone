export interface BrowserElement {
  ref: string
  role: string
  name: string
  box: [number, number, number, number]
  disabled?: boolean
  value?: string
  frameId?: string
  frameUrl?: string
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

export class ElementRegistry {
  private readonly targetId = globalThis.crypto.randomUUID()
  private generation = 0
  private elements = new Map<string, RegisteredElement>()

  refresh(elements: Omit<RegisteredElement, 'ref'>[]): string {
    this.generation += 1
    this.elements.clear()
    for (const [index, element] of elements.entries()) {
      const ref = `${this.targetId}:${this.generation}:e${index + 1}`
      this.elements.set(ref, { ...element, ref })
    }
    return `${this.targetId}:${this.generation}`
  }

  resolve(ref: unknown): RegisteredElement {
    const value = typeof ref === 'string' ? ref : ''
    const element = this.elements.get(value)
    if (!element) throw new StaleElementError(value || '<empty>')
    return { ...element }
  }

  clear(): void {
    this.generation += 1
    this.elements.clear()
  }
}

