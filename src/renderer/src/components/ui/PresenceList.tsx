import { useEffect, useReducer, useRef } from 'react'
import { Grow } from './index'
import { prefersReducedMotion } from '../../lib/usePresence'
import { createListPresence, LIST_EXIT_MS, type ListPhase } from '../../lib/list-presence'

/**
 * 带增删动效的列表（共用 ui 动效件，设计规范 §6「列表增删」）。
 *
 * 只对**稳定 id** 的列表生效：`getKey` 必须给同一行恒定的 id。排序变化与
 * 文字更新不会动画（身份不变就不是增删）；新增行用 `Grow` 长出，删除行保留
 * 一段只读投影后收起 —— 退场行设 `inert` + `aria-hidden`，不可点、不进 Tab 顺序。
 *
 * `scope` 变化（换会话 / 换项目）时重置身份簿记，避免把新 scope 的已有行
 * 当成新增而误播；组件卸载时清掉所有退场计时器。
 */
export function PresenceList<T>({
  items,
  getKey,
  scope,
  children
}: {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  /** 身份作用域；变化即清空上一个 scope 的退场快照与基线 */
  scope?: string
  children: (item: T, phase: ListPhase) => React.ReactNode
}): React.JSX.Element {
  const helper = useRef(createListPresence<T>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lastScope = useRef(scope)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const reduced = prefersReducedMotion()

  /* 换 scope：在渲染里先清，保证同一帧不会把新 scope 的行误判为新增 */
  if (lastScope.current !== scope) {
    helper.current.reset()
    lastScope.current = scope
  }

  const rows = helper.current.reconcile(
    items.map((item, index) => ({ id: getKey(item, index), item })),
    { motion: !reduced }
  )

  useEffect(() => {
    const exiting = new Set(rows.filter((row) => row.phase === 'exiting').map((row) => row.id))
    /* 已不再退场的行：清掉旧计时器（含「又回来了」与「已 settle」两种） */
    for (const [id, timer] of timers.current) {
      if (!exiting.has(id)) {
        clearTimeout(timer)
        timers.current.delete(id)
      }
    }
    for (const id of exiting) {
      if (timers.current.has(id)) continue
      const timer = setTimeout(() => {
        timers.current.delete(id)
        helper.current.settle(id)
        bump()
      }, reduced ? 1 : LIST_EXIT_MS)
      timers.current.set(id, timer)
    }
  })

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      helper.current.reset()
    },
    []
  )

  return (
    <>
      {rows.map((row) => (
        <Grow key={row.id} open={row.phase !== 'exiting'} enter={row.phase === 'entering'}>
          {children(row.item, row.phase)}
        </Grow>
      ))}
    </>
  )
}
