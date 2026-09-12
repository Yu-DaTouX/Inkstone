import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { TOOL_SECTIONS, type ToolSectionId } from '../../../../shared/ipc'
import { SECTION_TITLE } from './ToolSection'
import type { MessageKey } from '../../i18n'

/**
 * 「工具库」—— 把工具栏分区收起来 / 拿回来。
 *
 * ── 为什么是「移出」而不是「折叠」──
 * 用户的原话是「可以把右栏的项目隐藏到库内或者拿到右栏」。
 * 折叠（section 自己的小三角）解决的是「这一块暂时不想看」；
 * 库解决的是「我根本不用这块」—— 两者是不同的需求，
 * 所以库里的分区在工具栏里**完全不出现**（不是折叠起来）。
 *
 * ── 为什么列表里同时显示两边 ──
 * 只列「已隐藏的」会让人找不到自己在找什么（不知道某块到底在库里还是
 * 已经在栏里），所以列**全部**分区并标出当前位置 —— 一个列表两件事。
 */
export function ToolLibrary({ onClose }: { onClose: () => void }) {
  const t = useT()
  const order = useStore((s) => s.settings?.toolOrder)
  const hidden = useStore((s) => s.settings?.toolHidden)
  const setToolLayout = useStore((s) => s.setToolLayout)
  const ref = useRef<HTMLDivElement>(null)

  /* 点外面关掉 */
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const id = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', close)
    }
  }, [onClose])

  const hiddenSet = useMemo(() => new Set(hidden ?? []), [hidden])
  const dragging = useStore((s) => s.draggingSection)

  /*
   * 一开始拖就把浮层关掉（用户要求「从工具库拖到右栏」）：
   *   ① 浮层盖在工具栏上方，不关掉就看不到落点
   *   ② 拖拽一结束就自动关（不管落在哪），不留一个悬在空中的面板
   */
  useEffect(() => {
    if (dragging) onClose()
  }, [dragging, onClose])
  /**
   * 展示顺序 = 设置里的顺序（空则用默认）。
   * 库里的分区也按同一顺序排 —— 两边顺序一致，来回搬的时候不会「跳位置」。
   */
  const list: ToolSectionId[] = useMemo(() => {
    const saved = order?.length ? order : [...TOOL_SECTIONS]
    const known = new Set<string>(TOOL_SECTIONS)
    const out = saved.filter((x): x is ToolSectionId => known.has(x))
    for (const id of TOOL_SECTIONS) if (!out.includes(id)) out.push(id)
    return out
  }, [order])

  const toggle = (id: ToolSectionId): void => {
    const next = new Set(hiddenSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void setToolLayout({ toolHidden: [...next] })
  }

  const shownCount = list.length - hiddenSet.size

  return (
    <div className="tool-lib" ref={ref} data-testid="tool-lib">
      <div className="tl-head">
        <Icon name="layers" size={12} />
        <span>{t('tl.title')}</span>
        <span className="spacer" />
        <span className="tl-count" data-testid="tl-count">
          {shownCount}/{list.length}
        </span>
      </div>
      <div className="tl-hint">{t('tl.hint')}</div>

      <div className="tl-list">
        {list.map((id, i) => {
          const inLib = hiddenSet.has(id)
          return (
            <div
              key={id}
              className="tl-row"
              data-id={id}
              data-in-lib={inLib ? '1' : '0'}
              /*
               * 整行可拖（用户要求「可以从工具库拖拽到右栏」）。
               * 拖拽用指针事件，与工具栏内的排序、面板宽度同一套 ——
               * 项目里三处拖拽行为一致，维护时只需要懂一种。
               */
              onPointerDown={(e) => beginDrag(e, id, inLib)}
            >
              <span className="tl-grip" aria-hidden title={t('tl.dragHint')}>
                ⠿
              </span>
              <span className={`tl-dot ${inLib ? 'off' : 'on'}`} aria-hidden />
              <span className="tl-name">{t(SECTION_TITLE[id])}</span>
              <span className="spacer" />
              {/*
               * 顺手把「顺序」也暴露出来：Alt+↑↓ 调顺序。
               * 不用鼠标拖是因为在弹出层里拖会和「点外面关闭」打架。
               */}
              <button
                className="tl-move"
                title={t('tl.moveUp')}
                disabled={i === 0}
                data-testid={`tl-up-${id}`}
                onClick={() => void move(list, i, -1, setToolLayout)}
              >
                ↑
              </button>
              <button
                className="tl-move"
                title={t('tl.moveDown')}
                disabled={i === list.length - 1}
                data-testid={`tl-down-${id}`}
                onClick={() => void move(list, i, +1, setToolLayout)}
              >
                ↓
              </button>
              <button
                className={`tl-toggle ${inLib ? '' : 'on'}`}
                onClick={() => toggle(id)}
                data-testid={`tl-toggle-${id}`}
              >
                {inLib ? t('tl.takeOut') : t('tl.putIn')}
              </button>
            </div>
          )
        })}
      </div>

      <button className="tl-reset" onClick={() => void setToolLayout({ toolOrder: [], toolHidden: [] })} data-testid="tl-reset">
        {t('tl.reset')}
      </button>
    </div>
  )
}

/** 交换相邻两项并落盘（库里的上下移动） */
async function move(
  list: ToolSectionId[],
  i: number,
  dir: 1 | -1,
  save: (p: { toolOrder: string[] }) => Promise<void>
): Promise<void> {
  const j = i + dir
  if (j < 0 || j >= list.length) return
  const next = [...list]
  const tmp = next[i]
  next[i] = next[j]
  next[j] = tmp
  await save({ toolOrder: next })
}

/**
 * 从工具库发起拖拽。
 *
 * 为什么要在这里（而不是等用户在工具栏里拖）：因为**源和目标是两个组件**。
 * 做法：把「正在拖谁」放进 store，然后
 *   · 关掉工具库浮层（否则它盖住工具栏，用户看不到落点）
 *   · 在 document 上挂临时的 pointermove / pointerup（由 RightPanel 处理）
 *     —— 指针会离开这个元素，所以不能只听元素自己的事件
 *
 * 拖拽中那个跟着鼠标的小标签（「位置预览」的文字部分）也在 RightPanel，
 * 因为只有它知道当前落点算到了哪。
 */
function beginDrag(e: React.PointerEvent<HTMLDivElement>, id: ToolSectionId, inLib: boolean): void {
  if (e.button !== 0) return
  /*
   * 已在工具栏里的分区也能拖（用户可能想调位置），所以不区分 inLib ——
   * 它只影响提示文案。
   *
   * 但点在行内按钮（↑↓ / 收进库 / 拿到工具栏）上不能当拖拽，
   * 所以用 closest 排除 —— 不排除的话那些按钮会点不动。
   */
  void inLib
  if ((e.target as HTMLElement).closest('button')) return
  e.preventDefault()
  useStore.getState().setDraggingSection(id)
}
