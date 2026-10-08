import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { ContextMenuSurface, type ContextMenuAnchor } from '../common/ContextMenu'
import { useT } from '../../i18n'
import { DEFAULT_RAIL_VIEW, type RailGroupBy, type RailShow, type RailSortBy, type RailView } from '../../../../shared/rail-view'

const GROUP_OPTIONS: readonly RailGroupBy[] = ['project', 'state', 'date', 'none']
const SORT_OPTIONS: readonly RailSortBy[] = ['recent', 'name', 'created']
const SHOW_OPTIONS: readonly RailShow[] = ['active', 'archived']

/**
 * 左栏的「视图」菜单：分组方式与排序。
 *
 * 只改整理方式，不改会话本身；选择由调用方持久化。非默认视图时按钮点亮，
 * 提醒用户列表不是默认的「按项目 · 最近活动」。
 */
export function RailViewMenu({ view, onChange }: { view: RailView; onChange: (next: RailView) => void }) {
  const t = useT()
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null)
  const custom = view.group !== DEFAULT_RAIL_VIEW.group || view.sort !== DEFAULT_RAIL_VIEW.sort || view.show !== DEFAULT_RAIL_VIEW.show

  const option = (id: string, label: string, selected: boolean, pick: () => void) => (
    <button
      key={id}
      type="button"
      role="menuitem"
      className="ui-menu-item rail-view-item"
      aria-current={selected ? 'true' : undefined}
      data-testid={`rail-view-${id}`}
      onClick={() => { pick(); setAnchor(null) }}
    >
      <span className="rail-view-check">{selected ? <Icon name="check" size={12} /> : null}</span>
      <span>{label}</span>
    </button>
  )

  return (
    <>
      <button
        type="button"
        className={`rail-icon${custom ? ' on' : ''}`}
        title={t('rail.view')}
        aria-label={t('rail.view')}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        data-testid="rail-view"
        onClick={(event) => {
          if (anchor) { setAnchor(null); return }
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget })
        }}
      >
        <Icon name="layers" size={14} />
      </button>
      <ContextMenuSurface
        open={!!anchor}
        anchor={anchor}
        onClose={() => { anchor?.trigger?.focus?.(); setAnchor(null) }}
        testid="rail-view-menu"
      >
        <div className="ui-menu-title">{t('rail.viewGroup')}</div>
        {GROUP_OPTIONS.map((g) => option(`group-${g}`, t(`rail.viewGroup.${g}`), view.group === g, () => onChange({ ...view, group: g })))}
        <div className="ui-menu-sep" role="separator" />
        <div className="ui-menu-title">{t('rail.viewSort')}</div>
        {SORT_OPTIONS.map((s) => option(`sort-${s}`, t(`rail.viewSort.${s}`), view.sort === s, () => onChange({ ...view, sort: s })))}
        <div className="ui-menu-sep" role="separator" />
        <div className="ui-menu-title">{t('rail.viewShow')}</div>
        {SHOW_OPTIONS.map((v) => option(`show-${v}`, t(`rail.viewShow.${v}`), view.show === v, () => onChange({ ...view, show: v })))}
      </ContextMenuSurface>
    </>
  )
}
