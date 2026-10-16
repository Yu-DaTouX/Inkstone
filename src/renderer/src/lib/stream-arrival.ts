export const ARRIVAL_STAGGER_MS = 60
export const ARRIVAL_MAX_STAGGER = 8

export function arrivalStaggerIndex(order: number): number {
  if (!Number.isFinite(order) || order <= 0) return 0
  return Math.min(Math.floor(order), ARRIVAL_MAX_STAGGER - 1)
}

export interface ArrivalDecision {
  animate: boolean
  stagger: number
}

export interface ArrivalOptions {
  live?: boolean
  motion?: boolean
}

export interface ArrivalTracker {
  observe(keys: readonly string[], options?: ArrivalOptions): void
  decide(key: string, options?: ArrivalOptions): ArrivalDecision
  commit(): void
  reset(): void
  seenCount(): number
}

export interface ArrivalNode {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  position?: { start?: { offset?: number } }
  children?: ArrivalNode[]
}

const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'])

export function markArrivalBlocks(root: ArrivalNode): string[] {
  const keys: string[] = []
  for (const node of root.children ?? []) {
    if (node.type !== 'element' || !BLOCK_TAGS.has(node.tagName ?? '')) continue
    node.properties = { ...node.properties, 'data-arrival-block': true }
    const offset = node.position?.start?.offset
    if (typeof offset === 'number' && Number.isFinite(offset)) keys.push(String(offset))
  }
  return keys
}

const NO_ARRIVAL: ArrivalDecision = { animate: false, stagger: 0 }

export function createArrivalTracker(): ArrivalTracker {
  let seen = new Set<string>()
  let batch = new Map<string, ArrivalDecision>()
  let order = 0
  let initialized = false

  return {
    observe(keys, options) {
      if (!initialized || options?.live === false || options?.motion === false) {
        for (const key of keys) seen.add(key)
      }
      initialized = true
    },
    decide(key, options) {
      const live = options?.live !== false
      const motion = options?.motion !== false
      if (!live) return NO_ARRIVAL

      const cached = batch.get(key)
      if (cached) return cached

      const known = seen.has(key)
      let decision: ArrivalDecision
      if (!motion) {
        seen.add(key)
        decision = NO_ARRIVAL
      } else if (known) {
        decision = NO_ARRIVAL
      } else {
        seen.add(key)
        decision = { animate: true, stagger: arrivalStaggerIndex(order++) }
      }
      batch.set(key, decision)
      return decision
    },

    commit() {
      batch = new Map()
      order = 0
    },

    reset() {
      seen = new Set()
      batch = new Map()
      order = 0
      initialized = false
    },

    seenCount() {
      return seen.size
    }
  }
}
