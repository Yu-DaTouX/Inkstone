import { useStore, widgetsByPlacement, type WidgetPlacement } from '../../state/store'

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
