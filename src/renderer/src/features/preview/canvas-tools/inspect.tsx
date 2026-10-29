import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Check, Copy, SquareDashedMousePointer } from 'lucide-react'
import { EmptyState, IconButton } from '../../../ui'
import { stageRect, type CanvasFrameBox, type CanvasView } from '../html-canvas-model'
import { DockToggle } from './dock'
import type { CanvasElementInfo, CanvasTool, CanvasToolOverlayProps, CanvasToolPanelProps } from './types'
import './inspect.css'

function InspectMark({
  frame,
  view,
  info,
  kind
}: {
  frame: CanvasFrameBox
  view: CanvasView
  info: CanvasElementInfo
  kind: 'hover' | 'selection'
}): ReactElement {
  const box = stageRect(frame, view, info.rect)
  return (
    <div
      className="v3-canvas-mark"
      data-kind={kind}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <span className="v3-canvas-mark-tag" data-above={box.top >= 20 ? '1' : undefined}>
        {info.tag} · {info.rect.w} × {info.rect.h}
      </span>
    </div>
  )
}

function InspectOverlay({ frame, view, context }: CanvasToolOverlayProps): ReactElement | null {
  const forFrame = (info: CanvasElementInfo | null): CanvasElementInfo | null =>
    info && info.frameId === frame.viewport.id ? info : null
  const hover = forFrame(context.hover)
  const selection = forFrame(context.selection)
  if (!hover && !selection) return null
  return (
    <div className="v3-canvas-layer" aria-hidden data-testid={`v3-canvas-inspect-layer-${frame.viewport.id}`}>
      {selection ? <InspectMark frame={frame} view={view} info={selection} kind="selection" /> : null}
      {hover ? <InspectMark frame={frame} view={view} info={hover} kind="hover" /> : null}
    </div>
  )
}

function Prop({ label, value, swatch }: { label: string; value: string; swatch?: string }): ReactElement {
  return (
    <div className="v3-canvas-prop">
      <span className="v3-canvas-prop-key">{label}</span>
      <span className="v3-canvas-prop-value">
        {swatch ? <span className="v3-canvas-swatch" style={{ background: swatch }} aria-hidden /> : null}
        <span className="v3-canvas-prop-text" title={value}>
          {value || '—'}
        </span>
      </span>
    </div>
  )
}

function PropGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="v3-canvas-prop-group">
      <h3 className="v3-canvas-prop-title">{title}</h3>
      {children}
    </section>
  )
}

function InspectPanel({ context }: CanvasToolPanelProps): ReactElement {
  const { labels } = context
  const info = context.selection ?? context.hover
  const [copied, setCopied] = useState<string | null>(null)
  const selector = info ? info.selector : ''
  useEffect(() => {
    setCopied(null)
  }, [selector])
  const copy = (): void => {
    if (!selector || !navigator.clipboard) return
    void navigator.clipboard.writeText(selector).then(
      () => setCopied(selector),
      () => setCopied(null)
    )
  }
  if (context.narrow && context.dockCollapsed) {
    return (
      <aside className="v3-canvas-panel v3-canvas-dock-bar" data-canvas-interactive aria-label={labels.canvasInspectPanel} data-testid="v3-canvas-inspect-panel">
        <div className="v3-canvas-dock-row">
          {info ? (
            <code className="v3-canvas-dock-line" data-testid="v3-canvas-inspect-line">
              {info.tag}
              {info.id ? `#${info.id}` : ''} · {info.rect.w} × {info.rect.h}
            </code>
          ) : (
            <span className="v3-canvas-dock-hint">{labels.canvasDockPickElement}</span>
          )}
        </div>
        <DockToggle labels={labels} expanded={false} onToggle={context.toggleDock} />
      </aside>
    )
  }
  return (
    <aside className="v3-canvas-panel" data-canvas-interactive aria-label={labels.canvasInspectPanel} data-testid="v3-canvas-inspect-panel">
      <div className="v3-canvas-panel-head">
        <span className="v3-canvas-panel-title">{labels.canvasInspectTitle}</span>
        {context.narrow ? <DockToggle labels={labels} expanded onToggle={context.toggleDock} /> : null}
        {info ? (
          <IconButton
            size="sm"
            aria-label={copied === selector ? labels.canvasInspectCopied : labels.canvasInspectCopySelector}
            tooltip={copied === selector ? labels.canvasInspectCopied : labels.canvasInspectCopySelector}
            data-testid="v3-canvas-inspect-copy"
            onPress={copy}
          >
            {copied === selector ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        ) : null}
      </div>
      {!info ? (
        <EmptyState size="sm" align="start" className="v3-canvas-panel-empty" title={labels.canvasInspectEmpty} />
      ) : (
        <div className="v3-canvas-panel-body">
          <div className="v3-canvas-panel-headline">
            <code className="v3-canvas-panel-taglet">
              {info.tag}
              {info.id ? `#${info.id}` : ''}
            </code>
            <code className="v3-canvas-panel-selector" title={info.selector}>
              {info.selector}
            </code>
          </div>
          {info.text ? <p className="v3-canvas-panel-text">{info.text}</p> : null}
          <PropGroup title={labels.canvasInspectSize}>
            <Prop label={labels.canvasInspectFrameSize} value={`${info.rect.w} × ${info.rect.h} px`} />
            <Prop label={labels.canvasInspectBox} value={`${info.styles.width} / ${info.styles.height}`} />
          </PropGroup>
          <PropGroup title={labels.canvasInspectColors}>
            <Prop label={labels.canvasInspectColor} value={info.styles.color} swatch={info.styles.color} />
            <Prop label={labels.canvasInspectBackground} value={info.styles.backgroundColor} swatch={info.styles.backgroundColor} />
          </PropGroup>
          <PropGroup title={labels.canvasInspectTypography}>
            <Prop label={labels.canvasInspectFont} value={info.styles.fontFamily} />
            <Prop label={labels.canvasInspectFontSize} value={info.styles.fontSize} />
            <Prop label={labels.canvasInspectLineHeight} value={info.styles.lineHeight} />
            <Prop label={labels.canvasInspectWeight} value={info.styles.fontWeight} />
            <Prop label={labels.canvasInspectLetterSpacing} value={info.styles.letterSpacing} />
            <Prop label={labels.canvasInspectAlign} value={info.styles.textAlign} />
          </PropGroup>
          <PropGroup title={labels.canvasInspectSpacing}>
            <Prop label={labels.canvasInspectPadding} value={info.styles.padding} />
            <Prop label={labels.canvasInspectMargin} value={info.styles.margin} />
            <Prop label={labels.canvasInspectRadius} value={info.styles.borderRadius} />
          </PropGroup>
          <PropGroup title={labels.canvasInspectLayout}>
            <Prop label={labels.canvasInspectDisplay} value={info.styles.display} />
          </PropGroup>
          {info.sourceOffset === undefined ? null : (
            <PropGroup title={labels.canvasInspectSource}>
              <Prop label={labels.canvasInspectOffset} value={String(info.sourceOffset)} />
            </PropGroup>
          )}
        </div>
      )}
    </aside>
  )
}

export const inspectTool: CanvasTool = {
  id: 'inspect',
  icon: SquareDashedMousePointer,
  label: (labels) => labels.canvasToolInspect,
  shortcut: 'v',
  frameInput: 'bridge',
  Overlay: InspectOverlay,
  Panel: InspectPanel
}
