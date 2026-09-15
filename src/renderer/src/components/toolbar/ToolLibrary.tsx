import { useEffect, useMemo, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { TOOL_SECTIONS, type ToolSectionId } from '../../../../shared/ipc'
import { SECTION_TITLE } from './ToolSection'

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
 *
 * ── 操作用按钮，不提供「拖到工具栏」的手势 ──
 * 库里的每行直接给按钮：收进库 / 拿到工具栏、上移、下移，另有「恢复默认布局」。
 * 不在浮层里做拖拽：它与「点外面关闭」互相打架（拖动途中浮层消失就失去源元素），
 * 而且这几个按钮已经能完成同样的事。
 * 工具栏**内部**的拖动排序是另一回事，在 `RightPanel` 里。
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
            <div key={id} className="tl-row" data-id={id} data-in-lib={inLib ? '1' : '0'}>
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
