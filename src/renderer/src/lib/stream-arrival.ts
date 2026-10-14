/**
 * 流式新块到达的**纯身份簿记**（设计规范 §6「新内容整段到达」）。
 *
 * 干什么：流式回复里每出现一个新的顶层块（段落 / 列表 / 引用 / 标题 / 代码块），
 * 就让它整块淡入上移一次，块间错峰；**同一个块只播一次**，跨 token 不重播。
 *
 * 为什么是纯函数 / 无 React：
 *   · 渲染层只需要问「这个块是不是新的、排第几个」，不该把「哪些块见过」
 *     塞进组件 state（流式期间组件每帧重建，state 会抖）。
 *   · 身份用 Markdown 解析出的**起始偏移**（`node.position.start.offset`），
 *     不用时间猜、不伪造消息 id —— 偏移在块生命周期内稳定，且天然不重复。
 *
 * 调法（组件里）：
 *   const t = createArrivalTracker()
 *   t.decide(key, { live })   // 每个块挂载时问一次
 *   t.commit()                // 一次渲染提交后归零错峰批次
 *   t.reset()                 // 换 scope / 卸载
 *
 * `live=false`（历史回放、会话恢复、压缩重放）一律不入场；`motion=false`
 * （减少动效）不位移、不错峰，但仍把块记为「见过」，之后开启动效也不回头补播。
 */

export const ARRIVAL_STAGGER_MS = 60
export const ARRIVAL_MAX_STAGGER = 8

/** 第 n 个新块的错峰序号（0 起）；第 8 个及以后并入最后一档 */
export function arrivalStaggerIndex(order: number): number {
  if (!Number.isFinite(order) || order <= 0) return 0
  return Math.min(Math.floor(order), ARRIVAL_MAX_STAGGER - 1)
}

export interface ArrivalDecision {
  /** 本次挂载是否要播入场 */
  animate: boolean
  /** 错峰序号（0 起，已按上限压平） */
  stagger: number
}

export interface ArrivalOptions {
  /** 是否属于当前流式消息；默认 true */
  live?: boolean
  /** 动效是否开启；默认 true */
  motion?: boolean
}

export interface ArrivalTracker {
  /** 初次挂载与历史建立基线；切回 live 会话不重播已存在内容。 */
  observe(keys: readonly string[], options?: ArrivalOptions): void
  /** 对一个块问一次决定；同一渲染批次内对同一 key 幂等 */
  decide(key: string, options?: ArrivalOptions): ArrivalDecision
  /** 一次渲染提交后调用：清空本批错峰计数（不遗忘见过的块） */
  commit(): void
  /** 换 scope / 卸载：忘掉全部身份，下次从空开始 */
  reset(): void
  /** 诊断 / 测试：已记住多少个块 */
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

/** rehype 根级标记，不改变结构；嵌套段落随所属整块移动，不重复入场。 */
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
      /* 非 live：历史 / 恢复 / 压缩重放，一律不动画（也不登记身份） */
      if (!live) return NO_ARRIVAL

      const cached = batch.get(key)
      if (cached) return cached

      const known = seen.has(key)
      let decision: ArrivalDecision
      if (!motion) {
        /* 减少动效：不位移不错峰，但仍记为见过，避免之后补播 */
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
