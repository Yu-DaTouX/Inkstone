/**
 * 画布轮次层的几何与分支对齐（实施-26 R3）。
 *
 * 会话地图原来是「一个会话 = 一个节点」。轮次层要的是：节点可以**展开**成
 * 一条轮次链（一轮问答 = 一张卡），并且**子会话首轮与父会话对应的那一轮对齐**
 * —— 分叉关系一眼看得出来。
 *
 * 为什么单独放一层纯逻辑：几何与对齐是画布最容易出错的地方（重叠、出界、
 * 对齐到不存在的轮次），而它们**不需要 DOM 也不需要 Electron**。
 * 组件只负责把算好的坐标贴上去。
 *
 * 对齐锚点用 `branchOrigin`（会话摘要里那句「分叉自这句话」）：拿它去父会话的
 * 轮次里找**问题文本相同**的那一轮。找不到就不对齐 —— **不猜**（宁可两条链
 * 各排各的，也不把子会话挂到一句不相干的话旁边）。
 *
 * 对齐会让子会话（含其后代）整体上移，所以必须防重叠：与**同泳道同列**里任何
 * 没有一起平移的节点撞上就整条放弃（`reason: 'overlap'`），如实退回基础布局。
 */

export interface TurnLayerCardInput {
  /** 轮次身份（`ConversationTurn.id`） */
  id: string
  /** 本轮的问题原文，用于与 `branchOrigin` 匹配 */
  question: string
}

export interface TurnLayerNodeInput {
  path: string
  laneKey: string
  /** 分支深度：决定画布上的列（同 depth = 同列） */
  depth: number
  parentPath?: string
  /** 基础布局算出的节点 y（对齐前的值） */
  y: number
  /** 已展开的轮次；没展开就不参与轮次层 */
  turns?: TurnLayerCardInput[]
  /** 分叉自的那句话（会话摘要的 `branchOrigin`） */
  branchOrigin?: string
}

export interface TurnLayerOptions {
  /** 会话节点高度（轮次链从它下方开始） */
  nodeH: number
  /** 轮次卡高度 */
  cardH: number
  /** 卡与卡之间的竖直间距 */
  gap: number
  /** 节点与第一张卡之间的竖直间距 */
  layerGap: number
}

export interface TurnLayerCard {
  id: string
  index: number
  y: number
}

export interface TurnLayer {
  path: string
  cards: TurnLayerCard[]
  /** 整层高度（含卡与间距，不含节点） */
  height: number
  /** 基础起点与最终起点之差：>0 下拉、<0 上移 */
  shift: number
  /** 对齐成功的轮次 id */
  alignedTurnId?: string
}

export type AlignFailure = 'no-parent' | 'no-layer' | 'no-match' | 'overlap'

export interface AlignReport {
  path: string
  /** 父会话里被对上的轮次 id（失败时为空） */
  turnId?: string
  ok: boolean
  reason?: AlignFailure
  /** 失败时「本来想去的 y」（仅诊断用，不参与布局） */
  triedY?: number
}

export interface TurnLayerPlan {
  /** path → 该会话的轮次层（只含已展开且有轮次的会话） */
  layers: Record<string, TurnLayer>
  /** path → 对齐后的节点 y（未对齐的与输入相同） */
  nodeY: Record<string, number>
  align: AlignReport[]
}

/** 摘要截断匹配的最小锚点长度：再短就不足以认定「就是这一轮」 */
export const MIN_ORIGIN_PREFIX = 8

/** 比对前的规范化：折叠空白差异，避免只差一个换行就判「对不上」 */
export function normalizeOriginText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 在父会话的轮次里找 `branchOrigin` 对应的那一轮。
 *
 * 先精确比（规范化后相等），再退回**前缀包含**：`branchOrigin` 来自会话摘要，
 * 有长度上限，可能只是问题原文的开头一段。两种情况下不做包含匹配：
 * 锚点太短（< 8 字，会把「好」「继续」挂到不相干的轮次上）、锚点比原文还长
 * （那不是「被截断的摘要」，宁可不对齐也不猜）。
 */
export function matchOriginTurn(
  turns: TurnLayerCardInput[],
  branchOrigin: string
): TurnLayerCardInput | undefined {
  const needle = normalizeOriginText(branchOrigin)
  if (!needle) return undefined
  const exact = turns.find((t) => normalizeOriginText(t.question) === needle)
  if (exact) return exact
  /* 摘要截断匹配：锚点至少 8 字，且是问题原文的开头 */
  if (needle.length < MIN_ORIGIN_PREFIX) return undefined
  return turns.find((t) => normalizeOriginText(t.question).startsWith(needle))
}

export function planTurnLayers(nodes: TurnLayerNodeInput[], options: TurnLayerOptions): TurnLayerPlan {
  const { nodeH, cardH, gap, layerGap } = options
  /** 同列两节点算「撞上」的最小竖直间距：节点高度的三成（够放下标题与留白） */
  const minV = Math.max(6, Math.round(nodeH * 0.3))

  const byPath = new Map(nodes.map((n) => [n.path, n]))
  const y = new Map(nodes.map((n) => [n.path, n.y]))
  const children = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.parentPath || !byPath.has(n.parentPath)) continue
    const kids = children.get(n.parentPath) ?? []
    kids.push(n.path)
    children.set(n.parentPath, kids)
  }

  const shiftByPath = new Map<string, number>()
  const alignedTurn = new Map<string, string>()
  const align: AlignReport[] = []

  const subtreeOf = (path: string): string[] => {
    const out: string[] = []
    const stack = [path]
    while (stack.length > 0) {
      const p = stack.pop() as string
      out.push(p)
      for (const kid of children.get(p) ?? []) stack.push(kid)
    }
    return out
  }

  /* 按 depth 升序：父的最终位置必须先算出来，子才谈得上对齐 */
  for (const node of [...nodes].sort((a, b) => a.depth - b.depth)) {
    if (!node.turns?.length || !node.branchOrigin) continue
    if (!node.parentPath) {
      align.push({ path: node.path, ok: false, reason: 'no-parent' })
      continue
    }
    const parent = byPath.get(node.parentPath)
    const parentTurns = parent?.turns
    if (!parent || !parentTurns?.length) {
      align.push({ path: node.path, ok: false, reason: 'no-layer' })
      continue
    }
    const hit = matchOriginTurn(parentTurns, node.branchOrigin)
    if (!hit) {
      align.push({ path: node.path, ok: false, reason: 'no-match' })
      continue
    }

    const parentIndex = parentTurns.findIndex((t) => t.id === hit.id)
    const parentCardY = (y.get(parent.path) as number) + nodeH + layerGap + parentIndex * (cardH + gap)
    /* 子会话**首轮**要落在父的那一轮上：反推节点该在哪 */
    const desired = parentCardY - nodeH - layerGap
    const here = y.get(node.path) as number
    const delta = desired - here

    if (Math.abs(delta) < 1) {
      alignedTurn.set(node.path, hit.id)
      align.push({ path: node.path, turnId: hit.id, ok: true })
      continue
    }

    const moving = new Set(subtreeOf(node.path))
    const clash = nodes.some(
      (other) =>
        other.laneKey === node.laneKey &&
        other.depth === node.depth &&
        !moving.has(other.path) &&
        Math.abs((y.get(other.path) as number) - desired) < nodeH + minV
    )
    if (clash) {
      align.push({ path: node.path, turnId: hit.id, ok: false, reason: 'overlap', triedY: desired })
      continue
    }

    for (const p of moving) y.set(p, (y.get(p) as number) + delta)
    shiftByPath.set(node.path, delta)
    alignedTurn.set(node.path, hit.id)
    align.push({ path: node.path, turnId: hit.id, ok: true })
  }

  const nodeY: Record<string, number> = {}
  for (const n of nodes) nodeY[n.path] = y.get(n.path) as number

  const layers: Record<string, TurnLayer> = {}
  for (const n of nodes) {
    const turns = n.turns
    if (!turns?.length) continue
    const top = (y.get(n.path) as number) + nodeH + layerGap
    layers[n.path] = {
      path: n.path,
      cards: turns.map((turn, index) => ({ id: turn.id, index, y: top + index * (cardH + gap) })),
      height: turns.length * cardH + (turns.length - 1) * gap,
      shift: shiftByPath.get(n.path) ?? 0,
      ...(alignedTurn.has(n.path) ? { alignedTurnId: alignedTurn.get(n.path) as string } : {})
    }
  }

  return { layers, nodeY, align }
}
