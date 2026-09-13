export interface BrowserElement {
  ref: string
  role: string
  name: string
  box: [number, number, number, number]
  disabled?: boolean
  value?: string
}

export interface RegisteredElement extends BrowserElement {
  backendNodeId: number
}

export class StaleElementError extends Error {
  readonly code = 'STALE_ELEMENT'

  constructor(ref: string) {
    super(`元素引用已失效：${ref}。请重新调用 browser_observe。`)
    this.name = 'StaleElementError'
  }
}

/**
 * 一次 observe 产生的元素引用表。
 *
 * ref 形如 `<generation>:e<n>`，generation 每次 refresh/clear 递增：
 * 新一次观察后旧 ref 自动不可解析，不需要调用方自己清缓存。
 * 坐标与角色等来自 Observer，这里只负责「代际 + 查找 + 失效应答」。
 *
 * 注意：不要在任意 DOM 变动时 clear（见 browser.ts 里 debugger 监听的注释）——
 * 动态页面会因此让刚拿到的 ref 立刻失效；节点真被删了由 CDP 报 detached。
 */
export class ElementRegistry {
  private generation = 0
  private elements = new Map<string, RegisteredElement>()

  refresh(elements: Omit<RegisteredElement, 'ref'>[]): string {
    this.generation += 1
    this.elements.clear()
    for (const [index, element] of elements.entries()) {
      const ref = `${this.generation}:e${index + 1}`
      this.elements.set(ref, { ...element, ref })
    }
    return String(this.generation)
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

