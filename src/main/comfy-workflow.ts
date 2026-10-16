type UiLink = unknown[] | { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number; type?: string }

interface UiNode {
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type?: string; link?: number | null; widget?: { name: string } }>
  outputs?: Array<{ name?: string; type?: string; links?: number[] | null }>
  widgets_values?: unknown[] | Record<string, unknown>
  properties?: Record<string, unknown>
}

interface UiSubgraph {
  id: string
  name?: string
  inputs?: Array<{ name: string; type?: string; linkIds?: number[] }>
  outputs?: Array<{ name: string; type?: string; linkIds?: number[] }>
  nodes?: UiNode[]
  links?: UiLink[]
  definitions?: { subgraphs?: UiSubgraph[] }
}

export interface UiWorkflow {
  nodes?: UiNode[]
  links?: UiLink[]
  definitions?: { subgraphs?: UiSubgraph[] }
}

export interface ObjectInfoEntry {
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }
  output_node?: boolean
  api_node?: boolean
}

export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export type WorkflowKind = 'text-to-image' | 'image-to-image'

const FRONTEND_ONLY = new Set(['Note', 'MarkdownNote', 'PrimitiveNode', 'Reroute', 'Label (rgthree)', 'Fast Groups Muter (rgthree)', 'Fast Groups Bypasser (rgthree)'])
const LOADS_MEDIA = /LoadImage|ImageFolder|LoadVideo|VHS_Load|LoadAudio|Load3D/i
const LOADS_SINGLE_IMAGE = /^LoadImage(Output|Mask)?$/
const SAVES_IMAGE = /^SaveImage|SaveImage$|^Image Save$/
const SAVES_OTHER = /SaveVideo|SaveAnimated|SaveAudio|SaveWEBM|CreateVideo|VHS_VideoCombine|Save3D|SaveGLB/i
const SAMPLES = /Sampler|Guider|Sample|Director/i
const ENCODES_TEXT = /TextEncode|CLIPText|Prompt|Director/i
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

export class WorkflowError extends Error {
  constructor(readonly code: string, readonly reason?: string) {
    super(reason ? `${code}: ${reason}` : code)
  }
}

export function isApiPrompt(value: unknown): value is ApiPrompt {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'nodes' in value) return false
  const entries = Object.values(value as Record<string, unknown>)
  return entries.length > 0 && entries.every((node) => !!node && typeof node === 'object' && typeof (node as { class_type?: unknown }).class_type === 'string')
}

function collectSubgraphs(workflow: UiWorkflow): Map<string, UiSubgraph> {
  const out = new Map<string, UiSubgraph>()
  const visit = (list: UiSubgraph[] | undefined): void => {
    for (const sub of list ?? []) {
      if (!sub?.id || out.has(sub.id)) continue
      out.set(sub.id, sub)
      visit(sub.definitions?.subgraphs)
    }
  }
  visit(workflow.definitions?.subgraphs)
  return out
}

function activeTypes(workflow: UiWorkflow | ApiPrompt): string[] {
  if (isApiPrompt(workflow)) return Object.values(workflow).map((node) => node.class_type)
  const subgraphs = collectSubgraphs(workflow)
  const out: string[] = []
  const walk = (nodes: UiNode[] | undefined, depth: number): void => {
    for (const node of nodes ?? []) {
      if (node.mode === 2 || node.mode === 4 || FRONTEND_ONLY.has(node.type)) continue
      const sub = subgraphs.get(node.type)
      if (sub) {
        if (depth < 8) walk(sub.nodes, depth + 1)
      } else {
        out.push(node.type)
      }
    }
  }
  walk(workflow.nodes, 0)
  return out
}

export function classifyWorkflow(workflow: UiWorkflow | ApiPrompt): WorkflowKind | null {
  const types = activeTypes(workflow)
  if (!types.some((type) => SAVES_IMAGE.test(type)) || types.some((type) => SAVES_OTHER.test(type))) return null
  if (!types.some((type) => SAMPLES.test(type))) return null
  if (!types.some((type) => ENCODES_TEXT.test(type))) return null
  if (types.some((type) => type.startsWith('workflow>') || type.startsWith('workflow/'))) return null
  const loads = types.filter((type) => LOADS_MEDIA.test(type))
  if (!loads.length) return 'text-to-image'
  return loads.every((type) => LOADS_SINGLE_IMAGE.test(type)) ? 'image-to-image' : null
}

export function workflowNodeTypes(workflow: UiWorkflow | ApiPrompt): string[] {
  return [...new Set(activeTypes(workflow))]
}

interface LinkInfo {
  from: number
  slot: number
  to: number
  toSlot: number
  type?: string
}

function linkTable(links: UiLink[] | undefined): Map<number, LinkInfo> {
  const table = new Map<number, LinkInfo>()
  for (const link of links ?? []) {
    if (Array.isArray(link)) table.set(Number(link[0]), { from: Number(link[1]), slot: Number(link[2]), to: Number(link[3]), toSlot: Number(link[4]), type: typeof link[5] === 'string' ? link[5] : undefined })
    else if (link && typeof link === 'object') table.set(Number(link.id), { from: Number(link.origin_id), slot: Number(link.origin_slot), to: Number(link.target_id), toSlot: Number(link.target_slot), type: link.type })
  }
  return table
}

function isWidgetSpec(spec: unknown[] | undefined): boolean {
  const type = spec?.[0]
  return Array.isArray(type) || (typeof type === 'string' && WIDGET_TYPES.has(type))
}

function widgetOrder(info: ObjectInfoEntry | undefined, node: UiNode): Array<{ name: string; control: boolean }> {
  if (info?.input) {
    const entries = [...Object.entries(info.input.required ?? {}), ...Object.entries(info.input.optional ?? {})]
    return entries
      .filter(([, spec]) => isWidgetSpec(spec))
      .map(([name, spec]) => {
        const options = (spec[1] ?? {}) as { control_after_generate?: unknown }
        return { name, control: options.control_after_generate === true || (spec[0] === 'INT' && (name === 'seed' || name === 'noise_seed')) }
      })
  }
  return (node.inputs ?? [])
    .filter((input) => input.widget)
    .map((input) => ({ name: input.widget?.name ?? input.name, control: input.name === 'seed' || input.name === 'noise_seed' }))
}

function widgetValues(node: UiNode, info: ObjectInfoEntry | undefined): Record<string, unknown> {
  const inputs: Record<string, unknown> = {}
  const values = node.widgets_values
  const order = widgetOrder(info, node)
  if (Array.isArray(values)) {
    let index = 0
    for (const widget of order) {
      if (index >= values.length) break
      inputs[widget.name] = values[index++]
      if (widget.control && typeof values[index] === 'string' && CONTROL_VALUES.has(values[index] as string)) index++
    }
  } else if (values && typeof values === 'object') {
    const known = new Set(order.map((widget) => widget.name))
    for (const [name, value] of Object.entries(values)) if (known.has(name)) inputs[name] = value
  }
  return inputs
}

interface Scope {
  prefix: string
  nodes: Map<number, UiNode>
  links: Map<number, LinkInfo>
  sub?: UiSubgraph
  parent?: { scope: Scope; instance: UiNode }
}

type Source = { ref: [string, number] } | { value: unknown } | null

export function toApiPrompt(workflow: UiWorkflow | ApiPrompt, objectInfo: Record<string, ObjectInfoEntry>): ApiPrompt {
  if (isApiPrompt(workflow)) return JSON.parse(JSON.stringify(workflow)) as ApiPrompt
  const subgraphs = collectSubgraphs(workflow)
  const prompt: ApiPrompt = {}

  const scopeOf = (nodes: UiNode[] | undefined, links: UiLink[] | undefined, prefix: string, sub?: UiSubgraph, parent?: Scope['parent']): Scope => ({
    prefix,
    nodes: new Map((nodes ?? []).map((node) => [Number(node.id), node])),
    links: linkTable(links),
    sub,
    parent
  })
  const childScope = (scope: Scope, instance: UiNode): Scope | null => {
    const sub = subgraphs.get(instance.type)
    return sub ? scopeOf(sub.nodes, sub.links, `${scope.prefix}${instance.id}:`, sub, { scope, instance }) : null
  }

  const fromSubgraphInput = (scope: Scope, slot: number, depth: number): Source => {
    if (!scope.parent || !scope.sub) return null
    const slotDef = scope.sub.inputs?.[slot]
    if (!slotDef) return null
    const { instance } = scope.parent
    const input = instance.inputs?.find((item) => item.name === slotDef.name)
    if (input?.link != null) return resolveLink(scope.parent.scope, input.link, depth + 1)
    const values = instance.widgets_values
    if (Array.isArray(values) && values.length && !Array.isArray(instance.properties?.proxyWidgets)) {
      const widgetSlots = (scope.sub.inputs ?? []).filter((item) => typeof item.type === 'string' && WIDGET_TYPES.has(item.type))
      const index = widgetSlots.indexOf(slotDef)
      if (index >= 0 && index < values.length) return { value: values[index] }
    }
    return null
  }

  const resolveOrigin = (scope: Scope, originId: number, slot: number, depth: number): Source => {
    if (depth > 64) return null
    if (originId === -10) return fromSubgraphInput(scope, slot, depth)
    const source = scope.nodes.get(originId)
    if (!source || source.mode === 2) return null
    if (source.type === 'Reroute') {
      const upstream = source.inputs?.[0]?.link
      return upstream == null ? null : resolveLink(scope, upstream, depth + 1)
    }
    if (source.type === 'PrimitiveNode') {
      const values = source.widgets_values
      return { value: Array.isArray(values) ? values[0] : undefined }
    }
    if (source.mode === 4) {
      const type = source.outputs?.[slot]?.type
      const pass = source.inputs?.find((input) => input.link != null && (!type || input.type === type))
      return pass?.link == null ? null : resolveLink(scope, pass.link, depth + 1)
    }
    const child = childScope(scope, source)
    if (child) {
      const linkIds = child.sub?.outputs?.[slot]?.linkIds ?? []
      const inner = linkIds.map((id) => child.links.get(id)).find(Boolean) ??
        [...child.links.values()].find((link) => link.to === -20 && link.toSlot === slot)
      return inner ? resolveOrigin(child, inner.from, inner.slot, depth + 1) : null
    }
    return { ref: [`${scope.prefix}${source.id}`, slot] }
  }

  const resolveLink = (scope: Scope, linkId: number, depth = 0): Source => {
    const link = scope.links.get(linkId)
    return link ? resolveOrigin(scope, link.from, link.slot, depth) : null
  }

  const emit = (scope: Scope, depth: number): void => {
    for (const node of scope.nodes.values()) {
      if (node.mode === 2 || node.mode === 4 || FRONTEND_ONLY.has(node.type)) continue
      const child = childScope(scope, node)
      if (child) {
        if (depth >= 8) throw new WorkflowError('local_workflow_unsupported', '子图嵌套过深')
        emit(child, depth + 1)
        continue
      }
      if (node.type.startsWith('workflow>') || node.type.startsWith('workflow/')) {
        throw new WorkflowError('local_workflow_unsupported', `不支持组节点 ${node.type}`)
      }
      const info = objectInfo[node.type]
      if (!info) throw new WorkflowError('local_workflow_unsupported', `ComfyUI 没有节点 ${node.type}`)
      const inputs = widgetValues(node, info)
      for (const input of node.inputs ?? []) {
        if (input.link == null) continue
        const source = resolveLink(scope, input.link)
        if (!source) continue
        if ('value' in source && source.value === undefined) continue
        inputs[input.name] = 'ref' in source ? source.ref : source.value
      }
      prompt[`${scope.prefix}${node.id}`] = { class_type: node.type, inputs }
    }
  }

  emit(scopeOf(workflow.nodes, workflow.links, ''), 0)
  return prompt
}

export function usesApiNodes(prompt: ApiPrompt, objectInfo: Record<string, ObjectInfoEntry>): boolean {
  return Object.values(prompt).some((node) => objectInfo[node.class_type]?.api_node === true)
}

const PROMPT_KEYS = ['prompt', 'text', 'text_g', 'text_l', 'clip_l', 't5xxl', 'positive', 'positive_prompt', 'text_positive', 'global_prompt']
const NEGATIVE_INPUT = /negative|^neg|uncond|cond2/i

function isRef(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
}

function promptKeys(node: { class_type: string; inputs: Record<string, unknown> }): string[] {
  const keys = PROMPT_KEYS.filter((key) => typeof node.inputs[key] === 'string')
  if (!keys.length && /String|Text|Prompt/i.test(node.class_type) && typeof node.inputs.value === 'string') return ['value']
  return keys
}

function findPromptNodes(prompt: ApiPrompt): Array<{ id: string; keys: string[] }> {
  const starts: string[] = []
  for (const node of Object.values(prompt)) {
    if (!SAMPLES.test(node.class_type)) continue
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isRef(value) && /^(positive|conditioning|cond1|positive_conditioning)$/i.test(name)) starts.push(value[0])
    }
  }
  const seen = new Set<string>()
  let frontier = [...new Set(starts)]
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const hits: Array<{ id: string; keys: string[] }> = []
    const next: string[] = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      const node = prompt[id]
      if (!node) continue
      const keys = promptKeys(node)
      if (keys.length) {
        hits.push({ id, keys })
        continue
      }
      for (const [name, value] of Object.entries(node.inputs)) {
        if (isRef(value) && !NEGATIVE_INPUT.test(name)) next.push(value[0])
      }
    }
    if (hits.length) return hits
    frontier = next
  }
  return []
}

export function applyRequest(
  prompt: ApiPrompt,
  request: { prompt: string; width?: number; height?: number; images?: string[]; filenamePrefix?: string }
): ApiPrompt {
  const next: ApiPrompt = JSON.parse(JSON.stringify(prompt))
  let targets = findPromptNodes(next)
  if (!targets.length) {
    const candidates = Object.entries(next).map(([id, node]) => ({ id, keys: promptKeys(node) })).filter((item) => item.keys.length)
    if (candidates.length === 1) targets = candidates
  }
  if (!targets.length) throw new WorkflowError('local_workflow_unsupported', '工作流里找不到正向提示词输入')
  for (const target of targets) for (const key of target.keys) next[target.id].inputs[key] = request.prompt

  for (const node of Object.values(next)) {
    for (const name of ['seed', 'noise_seed']) {
      if (typeof node.inputs[name] === 'number') node.inputs[name] = Math.floor(Math.random() * 2 ** 48)
    }
    if (request.width && request.height && /Latent/i.test(node.class_type) && 'width' in node.inputs && 'height' in node.inputs) {
      node.inputs.width = request.width
      node.inputs.height = request.height
    }
    if (request.filenamePrefix && /^SaveImage/.test(node.class_type) && 'filename_prefix' in node.inputs) {
      node.inputs.filename_prefix = request.filenamePrefix
    }
  }

  if (request.images?.length) {
    const loaders = Object.values(next).filter((node) => LOADS_SINGLE_IMAGE.test(node.class_type) && 'image' in node.inputs)
    if (!loaders.length) throw new WorkflowError('local_workflow_unsupported', '工作流里没有 LoadImage 节点')
    loaders.forEach((node, index) => {
      node.inputs.image = request.images?.[Math.min(index, (request.images?.length ?? 1) - 1)]
    })
  }
  return next
}
