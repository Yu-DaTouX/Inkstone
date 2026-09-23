import { useEffect, useMemo, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { TOOL_SECTIONS, type ToolSectionId } from '../../../../shared/ipc'
import { SECTION_TITLE } from './ToolSection'
import {
  defaultFloatRect,
  defaultToolLayout,
  isTileFloatable,
  moveTileToIndex,
  setTilePlacement,
  type ToolLayout,
  type ToolRect,
  type ToolTile
} from '../../../../shared/tool-layout'

/**
 * 「工具库」—— 磁贴目录：停靠 / 浮动 / 收进库三选一的位置管理（实施-12 U-4）。
 *
 * ── 为什么列表里同时显示三处 ──
 * 只列「已隐藏的」会让人找不到自己在找什么（不知道某块到底在库里还是
 * 已经在栏里），所以列**全部**分区并标出当前位置 —— 一个列表三件事。
 *
 * ── 操作用按钮，不提供「拖到工具栏」的手势 ──
 * 库里的每行直接给按钮：收进库 / 拿回工具页 / 移出为浮动 / 定位、上移、下移，
 * 另有「恢复默认布局」。按钮路径也就是键盘路径（Tab + Enter 可达）；
 * U-5 的拖放是对同样的命令加一层手势，不是第二套逻辑。
 */
export function ToolLibrary({ onClose }: { onClose: () => void }) {
  const t = useT()
  const stored = useStore((s) => s.settings?.toolLayout)
  const setToolLayout = useStore((s) => s.setToolLayout)
  const ref = useRef<HTMLDivElement>(null)

  const layout = useMemo<ToolLayout>(() => stored ?? defaultToolLayout(TOOL_SECTIONS), [stored])

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

  /** 目录按 `order` 排：三处位置共用同一个序，来回搬的时候不会「跳位置」 */
  const list = useMemo(
    () => [...layout.tiles].sort((a, b) => a.order - b.order),
    [layout]
  )
  const dockedIds = useMemo(
    () => layout.tiles.filter((tile) => tile.placement === 'docked').sort((a, b) => a.order - b.order).map((tile) => tile.id),
    [layout]
  )
  const placedCount = list.filter((tile) => tile.placement !== 'library').length

  const put = (id: string, placement: ToolTile['placement']): void => {
    /* 浮动必须带 rect，否则契约会把它收回停靠位（见 setTilePlacement） */
    const rect: ToolRect | undefined = placement === 'floating' ? floatRectFor() : undefined
    void setToolLayout(setTilePlacement(layout, id, placement, rect))
  }
  /** 新建浮动磁贴的默认位置：与 RightPanel 的 Alt+← / 拖动入口一致 */
  const floatRectFor = (): ToolRect => {
    const box = document.querySelector('.workspace')?.getBoundingClientRect()
    const n = layout.tiles.filter((tile) => tile.placement === 'floating').length
    return defaultFloatRect(n, box?.width ?? 900, box?.height ?? 700)
  }
  const step = (id: string, dir: 1 | -1): void => {
    const i = dockedIds.indexOf(id)
    if (i < 0) return
    void setToolLayout(moveTileToIndex(layout, id, i + dir))
  }
  const locate = (id: string): void => {
    const el = document.querySelector(`[data-float-id="${id}"]`)
    if (!(el instanceof HTMLElement)) return
    el.classList.add('locate-flash')
    window.setTimeout(() => el.classList.remove('locate-flash'), 900)
  }

  return (
    <div className="tool-lib" ref={ref} data-testid="tool-lib">
      <div className="tl-head">
        <Icon name="layers" size={12} />
        <span>{t('tl.title')}</span>
        <span className="spacer" />
        <span className="tl-count" data-testid="tl-count">
          {placedCount}/{list.length}
        </span>
      </div>
      <div className="tl-hint">{t('tl.hint')}</div>

      <div className="tl-list">
        {list.map((tile, i) => {
          const id = tile.id as ToolSectionId
          const inLib = tile.placement === 'library'
          const floating = tile.placement === 'floating'
          const docked = tile.placement === 'docked'
          const di = dockedIds.indexOf(tile.id)
          const floatable = isTileFloatable(tile.id)
          return (
            <div key={tile.id} className="tl-row" data-id={tile.id} data-in-lib={inLib ? '1' : '0'} data-placement={tile.placement}>
              <span className={`tl-dot ${inLib ? 'off' : 'on'}`} aria-hidden />
              <span className="tl-name" title={t(SECTION_TITLE[id])}>
                {t(SECTION_TITLE[id])}
              </span>
              <span className="tl-pos" data-testid={`tl-pos-${tile.id}`}>
                {docked ? t('tl.posDock') : floating ? t('tl.posFloat') : t('tl.posLib')}
              </span>
              <span className="spacer" />
              {/*
               * 顺序只在停靠位有意义（浮动位置靠拖动，入库存起来）。
               * 上移/下移是键盘可达的排序路径。
               */}
              <button
                className="tl-move"
                title={t('tl.moveUp')}
                disabled={!docked || di <= 0}
                data-testid={`tl-up-${tile.id}`}
                onClick={() => step(tile.id, -1)}
              >
                ↑
              </button>
              <button
                className="tl-move"
                title={t('tl.moveDown')}
                disabled={!docked || di < 0 || di === dockedIds.length - 1}
                data-testid={`tl-down-${tile.id}`}
                onClick={() => step(tile.id, +1)}
              >
                ↓
              </button>
              {floatable && !floating ? (
                <button
                  className="tl-toggle"
                  title={t('tl.floatHint')}
                  data-testid={`tl-float-${tile.id}`}
                  onClick={() => put(tile.id, 'floating')}
                >
                  {t('tl.float')}
                </button>
              ) : null}
              {floating ? (
                <>
                  <button
                    className="tl-toggle"
                    title={t('tl.locateHint')}
                    data-testid={`tl-locate-${tile.id}`}
                    onClick={() => locate(tile.id)}
                  >
                    {t('tl.locate')}
                  </button>
                  <button
                    className="tl-toggle"
                    title={t('tl.dockHint')}
                    data-testid={`tl-dock-${tile.id}`}
                    onClick={() => put(tile.id, 'docked')}
                  >
                    {t('tl.dockBack')}
                  </button>
                </>
              ) : (
                <button
                  className={`tl-toggle ${docked ? 'on' : ''}`}
                  data-testid={`tl-toggle-${tile.id}`}
                  title={inLib ? t('tl.takeOut') : t('tl.putIn')}
                  onClick={() => put(tile.id, inLib ? 'docked' : 'library')}
                >
                  {inLib ? t('tl.takeOut') : t('tl.putIn')}
                </button>
              )}
              <span className="tl-index" aria-hidden data-testid={`tl-index-${tile.id}`}>
                {i + 1}
              </span>
            </div>
          )
        })}
      </div>

      <button
        className="tl-reset"
        /* 重置也要让 revision 递增，否则会被写入仲裁当成迟到写丢弃（踩过） */
        onClick={() => void setToolLayout({ ...defaultToolLayout(TOOL_SECTIONS), revision: layout.revision + 1 })}
        data-testid="tl-reset"
      >
        {t('tl.reset')}
      </button>
      {/*
       * 恢复默认只重置布局（停靠顺序、浮动位置、库），不清空任务、日志、
       * 上下文或产物 —— 那些是业务数据，不属于布局（设计 §5.3）。
       */}
    </div>
  )
}
