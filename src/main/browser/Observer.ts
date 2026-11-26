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
  frameId?: string
  contentDocument?: DOMNode
  shadowRoots?: DOMNode[]
}

type PageFrame = { id: string; parentId?: string; url?: string }
type PageFrameTree = { frame: PageFrame; childFrames?: PageFrameTree[] }

type LiveState = { kind?: string; value?: string; label?: string; checked?: boolean; selected?: boolean }

const LIVE_VALUE_LIMIT = 200
const ELEMENT_LIMIT = 150
const ALL_ELEMENT_LIMIT = 400
const MEASURE_BATCH = 16
const MAX_MEASURE_FACTOR = 3
const PAGE_TEXT_LIMIT = 500_000
const INERT_ROLES = ['presentation', 'none', 'generic']

export interface CaptureOptions {
  all?: boolean
  scope?: { backendNodeId: number; sessionId?: string }
}
const LIVE_TAGS = ['input', 'textarea', 'select', 'option']
const LIVE_ROLES = ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']

export const LIVE_STATE_FN = `function () {
  const el = this
  const tag = String(el.tagName || '').toLowerCase()
  const text = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim()
  if (tag === 'select') {
    const options = Array.from(el.options || [])
    const index = typeof el.selectedIndex === 'number' ? el.selectedIndex : -1
    const chosen = options[index] || options.find((option) => option.selected) || null
    return { kind: 'select', value: text(el.value), label: chosen ? text(chosen.label || chosen.text) : '' }
  }
  const secret = /(^|\\s)(cc-[a-z-]+|one-time-code)(\\s|$)/.test(String((typeof el.getAttribute === 'function' && el.getAttribute('autocomplete')) || '').toLowerCase())
  if (tag === 'input') {
    const type = String(el.type || '').toLowerCase()
    if (type === 'checkbox' || type === 'radio') return { kind: 'checked', checked: Boolean(el.checked) }
    if (type === 'password' || secret) return { kind: 'value', value: el.value ? '\u2022\u2022\u2022\u2022' : '' }
    return { kind: 'value', value: text(el.value) }
  }
  if (tag === 'textarea') return { kind: 'value', value: secret && el.value ? '\u2022\u2022\u2022\u2022' : text(el.value) }
  if (tag === 'option') return { kind: 'option', value: text(el.value), selected: Boolean(el.selected) }
  if (el.isContentEditable) return { kind: 'value', value: text(el.innerText) }
  if (typeof el.checked === 'boolean') return { kind: 'checked', checked: el.checked }
  if (el.value !== undefined && el.value !== null && typeof el.value !== 'object') return { kind: 'value', value: text(el.value) }
  return null
}`

function wantsLiveState(node: DOMNode, attributes: Record<string, string>): boolean {
  const name = String(node.localName || node.nodeName || '').toLowerCase()
  if (LIVE_TAGS.includes(name)) return true
  if (attributes.contenteditable === 'true') return true
  return LIVE_ROLES.includes(String(attributes.role ?? '').toLowerCase())
}

const SECRET_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|one-time-code)(\s|$)/

function sensitiveField(attributes: Record<string, string>): boolean {
  return String(attributes.type ?? '').toLowerCase() === 'password' || SECRET_AUTOCOMPLETE.test(String(attributes.autocomplete ?? '').toLowerCase())
}

function liveValue(live: LiveState | null | undefined, fallback: string | undefined): string | undefined {
  if (!live) return fallback
  if (live.kind === 'checked') return live.checked ? 'checked' : 'unchecked'
  if (live.kind === 'option') return `${live.value ?? ''}${live.selected ? ' selected' : ''}`.trim().slice(0, LIVE_VALUE_LIMIT)
  return (live.value ?? '').slice(0, LIVE_VALUE_LIMIT)
}

function frameList(root: PageFrameTree, out: PageFrame[] = []): PageFrame[] {
  out.push(root.frame)
  for (const child of root.childFrames ?? []) frameList(child, out)
  return out
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
  const role = attributes.role?.trim().toLowerCase()
  return ['a', 'button', 'input', 'textarea', 'select', 'option', 'summary'].includes(name) ||
    (role !== undefined && !INERT_ROLES.includes(role)) ||
    attributes.tabindex !== undefined ||
    attributes.contenteditable === 'true'
}

type Flat = { node: DOMNode; frameId: string; inScope: boolean }

function flatten(root: DOMNode, inheritedFrameId: string, isScope: (node: DOMNode) => boolean, inherited = false, out: Flat[] = []): Flat[] {
  const frameId = root.frameId || inheritedFrameId
  const inScope = inherited || isScope(root)
  out.push({ node: root, frameId, inScope })
  for (const child of root.children ?? []) flatten(child, frameId, isScope, inScope, out)
  for (const child of root.shadowRoots ?? []) flatten(child, frameId, isScope, inScope, out)
  if (root.contentDocument) flatten(root.contentDocument, root.contentDocument.frameId || root.frameId || frameId, isScope, inScope, out)
  return out
}

function offscreen(box: [number, number, number, number], viewport: { width: number; height: number } | null): boolean {
  if (!viewport) return false
  return box[0] + box[2] <= 0 || box[1] + box[3] <= 0 || box[0] >= viewport.width || box[1] >= viewport.height
}

function safeFrameUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(String(value ?? ''))
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

const HREF_CHARS = 90
const SECRET_PARAM = /token|secret|key|sig|auth|session|code|pass|ticket/i

export function linkHref(raw: string | undefined, base: string | undefined, pageUrl: string): string | undefined {
  const value = String(raw ?? '').trim()
  if (!value || /^(javascript|data|blob):/i.test(value)) return undefined
  let url: URL
  try {
    url = new URL(value, base || pageUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol === 'mailto:' || url.protocol === 'tel:' ? url.href.slice(0, HREF_CHARS) : undefined
  url.username = ''
  url.password = ''
  for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.set(key, '•')
  let origin = ''
  try { origin = new URL(pageUrl).origin } catch {}
  const text = url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.href
  return text.length > HREF_CHARS ? `${text.slice(0, HREF_CHARS)}…` : text
}

export class Observer {
  private autoAttach: Promise<void> | null = null
  private readonly sessionsByFrame = new Map<string, string>()
  private readonly sessionSetup = new Map<string, Promise<void>>()
  private readonly frameTreesBySession = new Map<string, PageFrameTree>()
  private readonly activeSessions = new Set<string>()
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly cdp: CdpChannel, private readonly registry: ElementRegistry) {
    this.unsubscribe.push(cdp.on('Target.attachedToTarget', (params) => {
      const target = params.targetInfo as Record<string, unknown> | undefined
      const sessionId = String(params.sessionId ?? '')
      if (!sessionId || target?.type !== 'iframe') return
      const targetId = String(target.targetId ?? '')
      if (targetId) this.sessionsByFrame.set(targetId, sessionId)
      this.activeSessions.add(sessionId)
      const ready = this.prepareFrameSession(sessionId).catch(() => undefined)
      this.sessionSetup.set(sessionId, ready)
    }))
    this.unsubscribe.push(cdp.on('Target.detachedFromTarget', (params) => {
      const sessionId = String(params.sessionId ?? '')
      this.activeSessions.delete(sessionId)
      for (const [frameId, mapped] of this.sessionsByFrame) if (mapped === sessionId) this.sessionsByFrame.delete(frameId)
      this.frameTreesBySession.delete(sessionId)
      this.sessionSetup.delete(sessionId)
    }))
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
    this.activeSessions.clear()
    this.sessionsByFrame.clear()
    this.frameTreesBySession.clear()
    this.sessionSetup.clear()
  }

  async readText(): Promise<{ text: string; url: string; title: string }> {
    const result = await this.cdp.send<{ result: { value?: { text?: string; url?: string; title?: string } } }>('Runtime.evaluate', {
      expression: `({text:(document.body?.innerText||"").slice(0,${PAGE_TEXT_LIMIT}),url:location.href,title:document.title})`,
      returnByValue: true,
      awaitPromise: true
    })
    const value = result.result.value ?? {}
    return { text: value.text ?? '', url: value.url ?? '', title: value.title ?? '' }
  }

  async capture(url: string, title: string, options: CaptureOptions = {}): Promise<BrowserObservation> {
    const limit = options.all ? ALL_ELEMENT_LIMIT : ELEMENT_LIMIT
    const scope = options.scope
    await this.enableFrameSessions()
    const metricsResult = this.cdp
      .send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }; layoutViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics')
      .catch(() => null)
    const [documentResult, axResult, pageResult] = await Promise.all([
      this.cdp.send<{ root: DOMNode }>('DOM.getDocument', { depth: -1, pierce: true }),
      this.cdp.send<{ nodes?: Array<Record<string, unknown>> }>('Accessibility.getFullAXTree', { maxDepth: 12 }),
      this.cdp.send<{ result: { value?: { text?: string; url?: string; title?: string } } }>('Runtime.evaluate', {
        expression: '({text:(document.body?.innerText||"").slice(0,30000),url:location.href,title:document.title})',
        returnByValue: true,
        awaitPromise: true
      })
    ])
    const layout = (await metricsResult)?.cssLayoutViewport ?? (await metricsResult)?.layoutViewport
    const viewport = layout?.clientWidth && layout?.clientHeight ? { width: layout.clientWidth, height: layout.clientHeight } : null
    const pageTree = await this.cdp.send<{ frameTree: PageFrameTree }>('Page.getFrameTree').catch(() => null)
    await Promise.all([...this.sessionSetup.values()])
    const frameById = new Map<string, PageFrame>()
    if (pageTree?.frameTree) for (const frame of frameList(pageTree.frameTree)) frameById.set(frame.id, frame)
    for (const tree of this.frameTreesBySession.values()) {
      for (const frame of frameList(tree)) frameById.set(frame.id, frame)
    }
    const frames = [...frameById.values()]
    const rootFrameId = pageTree?.frameTree.frame.id || ''
    const frameOffsets = await this.frameOffsets(frames, rootFrameId)
    const frameUrls = new Map(frames.map((frame) => [frame.id, safeFrameUrl(frame.url)]))
    const frameSessions = new Map<string, string | undefined>(frames.map((frame) => [frame.id, this.sessionsByFrame.get(frame.id)]))
    const perSessionAx = new Map<string, Map<number, Record<string, unknown>>>()
    perSessionAx.set('root', new Map())
    for (const node of axResult.nodes ?? []) {
      const backend = Number(node.backendDOMNodeId)
      if (Number.isFinite(backend)) perSessionAx.get('root')!.set(backend, node)
    }
    const frameDocuments: Array<{ frameId: string; sessionId?: string; root: DOMNode; ax: Array<Record<string, unknown>> }> = []
    const seenRoots = new Set([rootFrameId])
    for (const frame of frames) {
      if (frame.id === rootFrameId) continue
      const sessionId = frameSessions.get(frame.id)
      if (!sessionId || seenRoots.has(frame.id)) continue
      const ready = this.sessionSetup.get(sessionId)
      if (ready) await ready
      try {
        const [doc, ax] = await Promise.all([
          this.cdp.send<{ root: DOMNode }>('DOM.getDocument', { depth: -1, pierce: true }, sessionId),
          this.cdp.send<{ nodes?: Array<Record<string, unknown>> }>('Accessibility.getFullAXTree', { maxDepth: 12 }, sessionId)
        ])
        frameDocuments.push({ frameId: frame.id, sessionId, root: doc.root, ax: ax.nodes ?? [] })
        const mapped = new Map<number, Record<string, unknown>>()
        for (const node of ax.nodes ?? []) {
          const backend = Number(node.backendDOMNodeId)
          if (Number.isFinite(backend)) mapped.set(backend, node)
        }
        perSessionAx.set(sessionId, mapped)
        seenRoots.add(frame.id)
      } catch {
      }
    }
    const candidates: Omit<RegisteredElement, 'ref'>[] = []
    const candidateScope: boolean[] = []
    const visited = new Set<string>()
    const scopeIn = (sessionId: string | undefined) => (node: DOMNode): boolean =>
      Boolean(scope) && Number(node.backendNodeId) === scope!.backendNodeId && (scope!.sessionId ?? undefined) === sessionId
    const docs = [
      ...flatten(documentResult.root, rootFrameId, scopeIn(undefined)).map(({ node, frameId, inScope }) => ({ node, frameId, inScope, sessionId: frameSessions.get(frameId) })),
      ...frameDocuments.flatMap((doc) => flatten(doc.root, doc.frameId, scopeIn(doc.sessionId)).map(({ node, frameId, inScope }) => ({ node, frameId, inScope, sessionId: doc.sessionId })))
    ]
    const interactive: Array<{
      node: DOMNode
      frameId: string
      sessionId: string | undefined
      backendNodeId: number
      attributes: Record<string, string>
      inScope: boolean
    }> = []
    const ordered = scope ? [...docs.filter((doc) => doc.inScope), ...docs.filter((doc) => !doc.inScope)] : docs
    for (const { node, frameId, sessionId, inScope } of ordered) {
      const backendNodeId = Number(node.backendNodeId)
      const key = `${sessionId ?? 'root'}:${backendNodeId}`
      if (visited.has(key)) continue
      visited.add(key)
      const attributes = attrs(node)
      if (!Number.isFinite(backendNodeId) || !isInteractive(node, attributes)) continue
      interactive.push({ node, frameId, sessionId, backendNodeId, attributes, inScope })
      if (interactive.length >= limit * MAX_MEASURE_FACTOR) break
    }
    for (let start = 0; start < interactive.length && candidates.length < limit; start += MEASURE_BATCH) {
      const batch = interactive.slice(start, start + MEASURE_BATCH)
      const measured = await Promise.all(
        batch.map(async ({ node, frameId, sessionId, backendNodeId, attributes, inScope }) => {
          const box = await elementBox(this.cdp, backendNodeId, sessionId)
          if (!box || box[2] < 1 || box[3] < 1) return null
          const live = wantsLiveState(node, attributes) ? await this.liveState(backendNodeId, sessionId) : null
          return { node, frameId, sessionId, backendNodeId, attributes, box, live, inScope }
        })
      )
      for (const item of measured) {
        if (!item || candidates.length >= limit) continue
        const { node, frameId, sessionId, backendNodeId, attributes, box, live, inScope } = item
        const ax = perSessionAx.get(sessionId ?? 'root')?.get(backendNodeId)
        const axRole = (ax?.role as { value?: string } | undefined)?.value
        const axName = (ax?.name as { value?: string } | undefined)?.value
        const role = axRole || attributes.role || String(node.localName || node.nodeName || 'element').toLowerCase()
        const name = axName || attributes['aria-label'] || attributes.title || attributes.placeholder || (String(node.localName).toLowerCase() === 'select' ? attributes.name || attributes.id || '' : textOf(node))
        const href = String(node.localName || node.nodeName || '').toLowerCase() === 'a'
          ? linkHref(attributes.href, frameById.get(frameId)?.url, pageResult.result.value?.url || url)
          : undefined
        const [offsetX, offsetY]: [number, number] = sessionId ? frameOffsets.get(frameId) ?? [0, 0] : [0, 0]
        const placed: [number, number, number, number] = [box[0] + offsetX, box[1] + offsetY, box[2], box[3]]
        candidateScope.push(inScope)
        candidates.push({
          backendNodeId,
          sessionId,
          frameOffset: [offsetX, offsetY],
          role,
          name: name || role,
          box: placed,
          ...(href ? { href } : {}),
          ...(offscreen(placed, viewport) ? { offscreen: true } : {}),
          frameId,
          frameUrl: frameUrls.get(frameId),
          disabled: attributes.disabled !== undefined || attributes['aria-disabled'] === 'true',
          value: liveValue(live, sensitiveField(attributes) ? (attributes.value ? '\u2022\u2022\u2022\u2022' : undefined) : attributes.value)
        })
      }
    }
    const { generationId, refs } = this.registry.refresh(candidates)
    const refreshed = refs.map((ref) => this.registry.resolve(ref))
    return {
      generationId,
      url: pageResult.result.value?.url || url,
      title: pageResult.result.value?.title || title,
      text: pageResult.result.value?.text || '',
      elements: refreshed.map(({ backendNodeId: _backend, sessionId: _session, frameOffset: _offset, ...element }) => element),
      accessibilityNodeCount: axResult.nodes?.length ?? 0,
      frameCount: frames.length,
      observedFrameCount: new Set(candidates.map((candidate) => candidate.frameId).filter(Boolean)).size,
      ...(viewport ? { viewport } : {}),
      ...(scope ? { scopeRefs: refs.filter((_ref, index) => candidateScope[index]) } : {})
    }
  }

  private async liveState(backendNodeId: number, sessionId: string | undefined): Promise<LiveState | null> {
    let objectId: string | undefined
    try {
      const resolved = await this.cdp.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId)
      objectId = resolved?.object?.objectId
    } catch {
      return null
    }
    if (!objectId) return null
    try {
      const call = await this.cdp.send<{ result?: { value?: LiveState | null } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: LIVE_STATE_FN,
        returnByValue: true
      }, sessionId)
      return call?.result?.value ?? null
    } catch {
      return null
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined)
    }
  }

  private enableFrameSessions(): Promise<void> {
    if (this.autoAttach) return this.autoAttach
    this.autoAttach = (async () => {
      await this.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
      await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 120))
    })()
    return this.autoAttach
  }

  private async prepareFrameSession(sessionId: string): Promise<void> {
    const domains = ['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.enable', 'Network.enable']
    await Promise.all(domains.map((method) => this.cdp.send(method, {}, sessionId).catch(() => undefined)))
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => undefined)
    const tree = await this.cdp.send<{ frameTree?: PageFrameTree }>('Page.getFrameTree', {}, sessionId).catch(() => null)
    if (tree?.frameTree && this.activeSessions.has(sessionId)) {
      this.frameTreesBySession.set(sessionId, tree.frameTree)
      for (const frame of frameList(tree.frameTree)) this.sessionsByFrame.set(frame.id, sessionId)
    }
  }

  private async frameOffsets(frames: PageFrame[], rootFrameId: string): Promise<Map<string, [number, number]>> {
    const byId = new Map(frames.map((frame) => [frame.id, frame]))
    const offsets = new Map<string, [number, number]>([[rootFrameId, [0, 0]]])
    const pending = frames.filter((frame) => frame.id !== rootFrameId)
    for (let pass = 0; pass < frames.length && pending.length; pass++) {
      for (let index = pending.length - 1; index >= 0; index--) {
        const frame = pending[index]
        const parentId = frame.parentId
        if (!parentId || !offsets.has(parentId)) continue
        const parent = byId.get(parentId)
        const parentSession = parent ? this.sessionsByFrame.get(parent.id) : undefined
        try {
          const owner = await this.cdp.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: frame.id }, parentSession)
          const box = owner.backendNodeId ? await elementBox(this.cdp, owner.backendNodeId, parentSession) : null
          const [parentX, parentY] = offsets.get(parentId) ?? [0, 0]
          offsets.set(frame.id, [parentX + (box?.[0] ?? 0), parentY + (box?.[1] ?? 0)])
        } catch {
          offsets.set(frame.id, offsets.get(parentId) ?? [0, 0])
        }
        pending.splice(index, 1)
      }
    }
    return offsets
  }
}
