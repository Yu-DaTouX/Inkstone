/**
 * 并排视图的纯逻辑（WP-20b）。
 *
 * 「一个窗口并排看两条会话」的**取舍**都在这里：从分屏状态投影出实际要画的列、
 * 窄屏退回单栏、以及命令面板「并排打开」挑哪条会话。组件只负责画与绑交互，
 * 不在这里决定会话归属 —— 分屏的真实状态仍由 `state/split-view` 持有。
 *
 * 子 Agent 的「并排打开」把它的转录当成一个特殊列：它的身份是
 * `subagent:<runId>` 这一组伪会话 id（分屏状态只认 `sessionId` / `path`）。
 * 这类列**不是会话**：不能交给 `useRunnerVisibility`，也不能当成可激活的目标，
 * 所以 `isSessionTile` / `sessionTiles` 把它们挡在外面。
 *
 * 本文件不 import React / store / DOM，便于 `scripts/test-v3-side-by-side.mjs`
 * 在 Node 里直接钉死。
 */

import type { SplitLayout, SplitSessionRef } from '../state/split-view'

/** 子 Agent 转录列的伪会话 id 前缀。 */
export const SUBAGENT_TILE_PREFIX = 'subagent:'

/** 把一条子 Agent 运行变成分屏里的一列。 */
export function subagentTileRef(runId: string): SplitSessionRef {
  return { sessionId: `${SUBAGENT_TILE_PREFIX}${runId}` }
}

/** 从分屏引用还原子 Agent runId；不是子 Agent 列时返回 null。 */
export function subagentRunIdOf(ref: SplitSessionRef | null | undefined): string | null {
  const id = ref?.sessionId
  return id && id.startsWith(SUBAGENT_TILE_PREFIX) ? id.slice(SUBAGENT_TILE_PREFIX.length) : null
}

/** 这一列是不是**会话**（能在 pi 侧激活、能报告可见性）；子 Agent 转录列不是。 */
export function isSessionTile(ref: SplitSessionRef | null | undefined): boolean {
  if (!ref || subagentRunIdOf(ref)) return false
  return !!(ref.sessionId || ref.path)
}

/** 只留会话列（子 Agent 转录列不进 runner 可见性，避免把伪 id 发给主进程）。 */
export function sessionTiles(refs: readonly SplitSessionRef[]): SplitSessionRef[] {
  return refs.filter(isSessionTile)
}

export interface PaneLayout {
  tiles: SplitSessionRef[]
  live: number
}

/**
 * 实际要画的列。
 *
 *   · 没有分屏（或只剩一列）→ `null`，调用方画单会话版面；
 *   · 窄屏 → 只画焦点那一列（分屏状态保留，宽回来即恢复）；
 *   · 其余 → 原样返回分屏的列与焦点下标。
 */
export function collapsedPanes(split: SplitLayout | null, narrow: boolean): PaneLayout | null {
  if (!split || split.tiles.length < 2) return null
  if (narrow) return { tiles: [split.tiles[split.live]], live: 0 }
  return { tiles: split.tiles, live: split.live }
}

/** 命令面板挑「并排打开」对象时用到的会话字段（与会话列表同源）。 */
export interface SideBySideSession {
  id: string
  path: string
  archivedAt?: number
  lastActivityAt?: number
  updatedAt?: number
}

const normalizePath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b)

const sameRefAsSession = (ref: SplitSessionRef, session: SideBySideSession): boolean =>
  (!!ref.sessionId && ref.sessionId === session.id) || (!!ref.path && samePath(ref.path, session.path))

/**
 * 「并排打开」要打开哪条会话：最近活动的、不是当前视图、也不已在分屏里的那条。
 *
 * 不给第二选择就没有可并排的对象（例如只有一个会话）→ 返回 null，由调用方
 * 如实报「没有可以并排的会话」，不猜、不打开一条空会话。
 */
export function sideBySideCandidate(
  sessions: readonly SideBySideSession[],
  current: SplitSessionRef | null,
  taken: readonly SplitSessionRef[] = []
): SideBySideSession | null {
  const candidates = sessions.filter((session) => {
    if (session.archivedAt) return false
    if (current && sameRefAsSession(current, session)) return false
    return !taken.some((ref) => sameRefAsSession(ref, session))
  })
  candidates.sort(
    (a, b) => (b.lastActivityAt ?? b.updatedAt ?? 0) - (a.lastActivityAt ?? a.updatedAt ?? 0)
  )
  return candidates[0] ?? null
}
