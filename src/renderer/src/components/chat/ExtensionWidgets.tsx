import { useStore, widgetsByPlacement, type WidgetPlacement } from '../../state/store'

/**
 * pi 原生扩展文本组件（`ctx.ui.setWidget` 的 RPC 形态）。
 *
 * 只渲染扩展给的纯文本行，**不执行任何扩展脚本**；位置按 `widgetPlacement`
 * 显示在输入区上方 / 下方（缺省 aboveEditor，见设计规范 §4.4）。
 *
 * 清空与后台会话归属由 store 保证：扩展发 `setWidget` 不带 lines 时，
 * `widgets` / `widgetPlacements` 里对应 key 一起删除，切会话时按会话快照投影。
 */
export function ExtensionWidgets({ placement }: { placement: WidgetPlacement }) {
  const widgets = useStore((s) => s.widgets)
  const placements = useStore((s) => s.widgetPlacements)
  const groups = widgetsByPlacement(widgets, placements)
  const entries = placement === 'belowEditor' ? groups.belowEditor : groups.aboveEditor
  if (entries.length === 0) return null

  return (
    <div
      className="ext-widgets"
      data-placement={placement}
      data-testid={placement === 'belowEditor' ? 'ext-widgets-below' : 'ext-widgets-above'}
    >
      {entries.map(([key, lines]) => (
        <div className="rp-widget ext-widget" key={key} data-widget-key={key}>
          <div className="rp-widget-key">{key}</div>
          {lines.map((line, index) => (
            <div className="rp-widget-line" key={index}>
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
