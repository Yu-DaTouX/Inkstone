/**
 * 把当前页面变成模型能用的「可交互元素表」。
 *
 * 做法：DOM 全量快照 + 无障碍树 + `DOM.getBoxModel` 逐个体积，
 * 只保留可见且有尺寸的可交互节点（最多 80 个），交给 ElementRegistry
 * 编上 generation-scoped ref。
 *
 * 盒坐标由 geometry.ts 提供：它是**相对视口**的 CSS 像素，与 Input 事件同一套。
 */
import type { CdpChannel } from './CdpChannel'
import type { ElementRegistry, RegisteredElement } from './ElementRegistry'
import { elementBox } from './geometry'
import type { BrowserObservation } from '../../shared/ipc'

type DOMNode = {
  nodeId: number
  backendNodeId?: number
  nodeName?: string
  localName?: string
  nodeValue?: string
  attributes?: string[]
  children?: DOMNode[]
}

function attrs(node: DOMNode): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2) out[node.attributes![i]] = node.attributes![i + 1]
  return out
}

function textOf(node: DOMNode, limit = 160): string {
  let text = node.nodeValue ?? ''
  for (const child of node.children ?? []) {
    if (text.length >= limit) break
    text += ` ${textOf(child, limit - text.length)}`
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function isInteractive(node: DOMNode, attributes: Record<string, string>): boolean {
  const name = String(node.localName || node.nodeName || '').toLowerCase()
  return ['a', 'button', 'input', 'textarea', 'select', 'option', 'summary'].includes(name) ||
    attributes.role !== undefined ||
    attributes.tabindex !== undefined ||
    attributes.contenteditable === 'true'
}

function flatten(root: DOMNode, out: DOMNode[] = []): DOMNode[] {
  out.push(root)
  for (const child of root.children ?? []) flatten(child, out)
  return out
}

export class Observer {
  constructor(private readonly cdp: CdpChannel, private readonly registry: ElementRegistry) {}

  async capture(url: string, title: string): Promise<BrowserObservation> {
    const [documentResult, axResult, snapshotResult, pageResult] = await Promise.all([
      this.cdp.send<{ root: DOMNode }>('DOM.getDocument', { depth: -1, pierce: true }),
      this.cdp.send<{ nodes?: Array<Record<string, unknown>> }>('Accessibility.getFullAXTree', { maxDepth: 12 }),
      this.cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includePaintOrder: false, includeDOMRects: true }).catch(() => null),
      this.cdp.send<{ result: { value?: { text?: string; url?: string; title?: string } } }>('Runtime.evaluate', {
        expression: '({text:(document.body?.innerText||"").slice(0,30000),url:location.href,title:document.title})',
        returnByValue: true,
        awaitPromise: true
      })
    ])
    const axByBackend = new Map<number, Record<string, unknown>>()
    for (const node of axResult.nodes ?? []) {
      const backend = Number(node.backendDOMNodeId)
      if (Number.isFinite(backend)) axByBackend.set(backend, node)
    }
    const candidates: Omit<RegisteredElement, 'ref'>[] = []
    for (const node of flatten(documentResult.root)) {
      const backendNodeId = Number(node.backendNodeId)
      const attributes = attrs(node)
      if (!Number.isFinite(backendNodeId) || !isInteractive(node, attributes)) continue
      const box = await elementBox(this.cdp, backendNodeId)
      if (!box || box[2] < 1 || box[3] < 1) continue
      const ax = axByBackend.get(backendNodeId)
      const axRole = (ax?.role as { value?: string } | undefined)?.value
      const axName = (ax?.name as { value?: string } | undefined)?.value
      const role = axRole || attributes.role || String(node.localName || node.nodeName || 'element').toLowerCase()
      const name = axName || attributes['aria-label'] || attributes.title || attributes.placeholder || textOf(node)
      candidates.push({
        backendNodeId,
        role,
        name: name || role,
        box,
        disabled: attributes.disabled !== undefined || attributes['aria-disabled'] === 'true',
        value: attributes.value
      })
      if (candidates.length >= 80) break
    }
    const generationId = this.registry.refresh(candidates)
    const refreshed = candidates.map((_, index) => this.registry.resolve(`${generationId}:e${index + 1}`))
    return {
      generationId,
      url: pageResult.result.value?.url || url,
      title: pageResult.result.value?.title || title,
      text: pageResult.result.value?.text || '',
      elements: refreshed.map(({ backendNodeId: _backend, ...element }) => element),
      accessibilityNodeCount: axResult.nodes?.length ?? 0,
      domSnapshotCaptured: snapshotResult !== null
    }
  }
}
