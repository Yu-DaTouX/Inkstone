import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button, ListBoxItem, Select, TextArea, TextField } from '../../../ui'
import { HTML_CANVAS_CHANNEL } from '../../../../../shared/html-canvas-bridge'
import { htmlElementSpan, type HtmlEditPatch, type HtmlPatchStyle } from '../../../../../shared/html-edit-patch'
import { readHtmlStartTag, readHtmlTagAttribute } from '../../../../../shared/html-source-map'
import { stageRect } from '../html-canvas-model'
import type { CanvasElementInfo, CanvasTool, CanvasToolOverlayProps, CanvasToolPanelProps } from './types'
import { DockToggle } from './dock'
import { editProblemText, editText, type EditText } from './edit-text'
import './edit.css'

interface StyleField {
  property: string
  label: (text: EditText) => string
  initial: (info: CanvasElementInfo) => string
  swatch?: boolean
}

const STYLE_FIELDS: readonly StyleField[] = [
  { property: 'color', label: (text) => text.color, initial: (info) => info.styles.color, swatch: true },
  { property: 'background-color', label: (text) => text.background, initial: (info) => info.styles.backgroundColor, swatch: true },
  { property: 'font-size', label: (text) => text.fontSize, initial: (info) => info.styles.fontSize },
  { property: 'font-weight', label: (text) => text.fontWeight, initial: (info) => info.styles.fontWeight },
  { property: 'line-height', label: (text) => text.lineHeight, initial: (info) => info.styles.lineHeight },
  { property: 'letter-spacing', label: (text) => text.letterSpacing, initial: (info) => info.styles.letterSpacing },
  { property: 'padding', label: (text) => text.padding, initial: (info) => info.styles.padding },
  { property: 'border-radius', label: (text) => text.radius, initial: (info) => info.styles.borderRadius },
  { property: 'width', label: (text) => text.width, initial: (info) => info.styles.width }
]

const ALIGN_KEYS = ['left', 'center', 'right', 'justify'] as const

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026'
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name] ?? match
  })
}

function alignKeyOf(value: string): string | null {
  const normalized = value === 'start' ? 'left' : value === 'end' ? 'right' : value
  return (ALIGN_KEYS as readonly string[]).includes(normalized) ? normalized : null
}

function alignItems(text: EditText): Array<{ key: string; label: string }> {
  return [
    { key: 'left', label: text.alignStart },
    { key: 'center', label: text.alignCenter },
    { key: 'right', label: text.alignEnd },
    { key: 'justify', label: text.alignJustify }
  ]
}

function EditOverlay({ frame, view, context }: CanvasToolOverlayProps): ReactElement | null {
  const forFrame = (info: CanvasElementInfo | null): CanvasElementInfo | null =>
    info && info.frameId === frame.viewport.id ? info : null
  const hover = forFrame(context.hover)
  const selection = forFrame(context.selection)
  if (!hover && !selection) return null
  const marks = [
    selection ? { info: selection, kind: 'selection' as const } : null,
    hover && hover !== selection ? { info: hover, kind: 'hover' as const } : null
  ]
  return (
    <div className="v3-canvas-edit-layer" aria-hidden data-testid={`v3-canvas-edit-layer-${frame.viewport.id}`}>
      {marks.map((mark) => {
        if (!mark) return null
        const box = stageRect(frame, view, mark.info.rect)
        return (
          <div
            key={mark.kind}
            className="v3-canvas-edit-mark"
            data-kind={mark.kind}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            {mark.kind === 'selection' ? (
              <span className="v3-canvas-edit-mark-tag" data-above={box.top >= 20 ? '1' : undefined}>
                {mark.info.tag}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="v3-canvas-edit-group">
      <h3 className="v3-canvas-edit-group-title">{title}</h3>
      <div className="v3-canvas-edit-grid">{children}</div>
    </section>
  )
}

function EditBar({
  context,
  text,
  line,
  action
}: {
  context: CanvasToolPanelProps['context']
  text: EditText
  line: ReactNode
  action?: ReactNode
}): ReactElement {
  return (
    <aside
      className="v3-canvas-edit-panel v3-canvas-dock-bar"
      data-canvas-interactive
      aria-label={text.panel}
      data-testid="v3-canvas-edit-panel"
    >
      <div className="v3-canvas-dock-row">{line}</div>
      {action}
      <DockToggle labels={context.labels} expanded={false} onToggle={context.toggleDock} />
    </aside>
  )
}

function editLine(info: CanvasElementInfo): ReactElement {
  return (
    <code className="v3-canvas-dock-line">
      {info.tag}
      {info.id ? `#${info.id}` : ''} · {info.rect.w} × {info.rect.h}
    </code>
  )
}

function EditPanel({ context }: CanvasToolPanelProps): ReactElement {
  const text = editText(context.labels.lang)
  const compact = context.narrow && context.dockCollapsed
  const info = context.selection
  const frameId = info?.frameId ?? ''
  const path = info?.path ?? ''
  const tag = info?.tag ?? ''
  const offset = info?.sourceOffset
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [attributeEdits, setAttributeEdits] = useState<Record<string, string>>({})
  const [textEdit, setTextEdit] = useState<string | null>(null)
  const [source, setSource] = useState<{ hash: string; text: string } | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'apply' | 'undo' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const [undoHash, setUndoHash] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const restore = useRef<{ frameId: string; path: string } | null>(null)
  const selectionPath = useRef(path)
  selectionPath.current = path
  const postRef = useRef(context.postToFrame)
  postRef.current = context.postToFrame
  const reloadFramesRef = useRef(context.reloadFrames)
  reloadFramesRef.current = context.reloadFrames
  const identity = `${frameId}|${path}|${offset ?? ''}`

  const startTag = source && offset !== undefined && tag ? readHtmlStartTag(source.text, offset) : null
  const tagMatches = Boolean(startTag) && startTag !== null && startTag.name.toLowerCase() === tag
  const tagText = source && startTag && tagMatches ? source.text.slice(startTag.offset, startTag.end) : ''
  const span = source && tagMatches && offset !== undefined ? htmlElementSpan(source.text, offset, tag) : null
  const rawContent = span && source ? source.text.slice(span.contentStart, span.contentEnd) : ''
  const leaf = Boolean(span) && !rawContent.includes('<')
  const initialText = leaf ? decodeEntities(rawContent) : info?.text ?? ''
  const textValue = textEdit ?? initialText
  const textDirty = leaf && textEdit !== null && textEdit !== initialText
  const mismatch = Boolean(source) && !tagMatches
  const sourceReady = Boolean(source) && tagMatches
  const previewText = leaf ? textValue : null
  const styleOverrides: Record<string, string> = edits
  const styleKey = JSON.stringify(styleOverrides)
  const previewRef = useRef<{ styles: Record<string, string>; text: string | null }>({ styles: styleOverrides, text: previewText })
  previewRef.current = { styles: styleOverrides, text: previewText }

  useEffect(() => {
    setEdits({})
    setAttributeEdits({})
    setTextEdit(null)
    setProblem(null)
    setApplied(false)
  }, [identity])

  useEffect(() => {
    setUndoHash(null)
  }, [context.abs])

  useEffect(() => {
    if (offset === undefined || !tag || context.generating) return undefined
    let live = true
    setSource(null)
    setSourceError(null)
    void window.yan.readEditableFile(context.abs, context.cwd).then(
      (view) => {
        if (!live) return
        if (!view.ok) {
          setSourceError(view.error ?? 'failed')
          return
        }
        setSource({ hash: view.hash, text: view.text })
      },
      () => {
        if (live) setSourceError('failed')
      }
    )
    return () => {
      live = false
    }
  }, [identity, context.abs, context.cwd, context.generating, reloads, offset, tag])

  useEffect(() => {
    if (!frameId) return undefined
    const target = frameId
    return () => {
      postRef.current(target, { [HTML_CANVAS_CHANNEL]: 'edit-reset' })
    }
  }, [frameId])

  useEffect(() => {
    if (!frameId || !path) return undefined
    const timer = window.setTimeout(() => {
      postRef.current(frameId, { [HTML_CANVAS_CHANNEL]: 'edit-preview', path, ...previewRef.current })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [frameId, path, styleKey, previewText])

  useEffect(() => {
    const pending = restore.current
    if (!pending) return undefined
    let tries = 0
    const timer = window.setInterval(() => {
      tries += 1
      if (selectionPath.current && selectionPath.current !== pending.path) {
        window.clearInterval(timer)
        restore.current = null
        return
      }
      postRef.current(pending.frameId, { [HTML_CANVAS_CHANNEL]: 'edit-select', path: pending.path })
      if (tries >= 8) {
        window.clearInterval(timer)
        restore.current = null
      }
    }, 220)
    return () => window.clearInterval(timer)
  }, [reloads])

  if (!info) {
    if (compact) {
      return (
        <EditBar
          context={context}
          text={text}
          line={<span className="v3-canvas-dock-hint">{context.labels.canvasDockPickElement}</span>}
        />
      )
    }
    return (
      <aside className="v3-canvas-edit-panel" data-canvas-interactive aria-label={text.panel} data-testid="v3-canvas-edit-panel">
        <div className="v3-canvas-edit-head">
          <span className="v3-canvas-edit-title">{text.panel}</span>
          {context.narrow ? <DockToggle labels={context.labels} expanded onToggle={context.toggleDock} /> : null}
        </div>
        <p className="v3-canvas-edit-empty">{text.empty}</p>
      </aside>
    )
  }

  if (offset === undefined) {
    if (compact) {
      return <EditBar context={context} text={text} line={editLine(info)} />
    }
    return (
      <aside className="v3-canvas-edit-panel" data-canvas-interactive aria-label={text.panel} data-testid="v3-canvas-edit-panel">
        <div className="v3-canvas-edit-head">
          <span className="v3-canvas-edit-title">{text.panel}</span>
          <code className="v3-canvas-edit-taglet">{info.tag}</code>
          {context.narrow ? <DockToggle labels={context.labels} expanded onToggle={context.toggleDock} /> : null}
        </div>
        <p className="v3-canvas-edit-empty" data-testid="v3-canvas-edit-generated">
          {text.generated}
        </p>
      </aside>
    )
  }

  const initialAttribute = (name: string): string => (tagText ? readHtmlTagAttribute(tagText, name) ?? '' : '')
  const hrefShown = info.tag === 'a' || info.tag === 'area' || initialAttribute('href') !== ''
  const imageShown = info.tag === 'img'

  const setStyle = (property: string, value: string, initial: string): void => {
    setEdits((current) => {
      const next = { ...current }
      if (value === initial) delete next[property]
      else next[property] = value
      return next
    })
    setApplied(false)
  }

  const setAttribute = (name: string, value: string): void => {
    const initial = initialAttribute(name)
    setAttributeEdits((current) => {
      const next = { ...current }
      if (value === initial) delete next[name]
      else next[name] = value
      return next
    })
    setApplied(false)
  }

  const dirty = Object.keys(edits).length > 0 || Object.keys(attributeEdits).length > 0 || textDirty

  const reloadFrame = (): void => {
    restore.current = { frameId, path }
    setSource(null)
    setReloads((value) => value + 1)
    reloadFramesRef.current()
  }

  const apply = async (): Promise<void> => {
    if (!source || offset === undefined || !dirty || busy || context.generating) return
    const styles: HtmlPatchStyle[] = Object.entries(edits).map(([property, value]) => ({
      property,
      value: value.trim() ? value : null
    }))
    const attributes = Object.entries(attributeEdits).map(([name, value]) => ({ name, value: value.trim() ? value : null }))
    const patch: HtmlEditPatch = {}
    if (styles.length) patch.styles = styles
    if (attributes.length) patch.attributes = attributes
    if (textDirty && textEdit !== null) patch.text = textEdit
    setBusy('apply')
    setProblem(null)
    try {
      const result = await window.yan.htmlEdit.apply({
        path: context.abs,
        cwd: context.cwd,
        sha256: source.hash,
        frameHash: context.frameHash(frameId),
        sourceOffset: offset,
        tag: info.tag,
        patch
      })
      if (!result.ok) {
        setProblem(editProblemText(text, result.error))
        setBusy(null)
        return
      }
      setBusy(null)
      if (!result.sha256) {
        setProblem(text.failed)
        return
      }
      setUndoHash(result.sha256)
      setApplied(true)
      setEdits({})
      setAttributeEdits({})
      setTextEdit(null)
      reloadFrame()
    } catch {
      setBusy(null)
      setProblem(text.failed)
    }
  }

  const undo = async (): Promise<void> => {
    if (!undoHash || busy) return
    const basis = undoHash
    setBusy('undo')
    setProblem(null)
    try {
      const result = await window.yan.htmlEdit.undo({ path: context.abs, cwd: context.cwd, sha256: basis })
      if (!result.ok) {
        setProblem(editProblemText(text, result.error))
        setBusy(null)
        return
      }
      setBusy(null)
      setApplied(false)
      setUndoHash(null)
      setEdits({})
      setAttributeEdits({})
      setTextEdit(null)
      reloadFrame()
    } catch {
      setBusy(null)
      setProblem(text.failed)
    }
  }

  const discard = (): void => {
    setEdits({})
    setAttributeEdits({})
    setTextEdit(null)
    setProblem(null)
    setApplied(false)
    postRef.current(frameId, { [HTML_CANVAS_CHANNEL]: 'edit-reset' })
  }

  const blocked = context.generating ? text.generating : null
  const note =
    blocked ??
    (mismatch
      ? text.sourceMismatch
      : sourceError === 'too-large'
        ? text.sourceTooLarge
        : sourceError
          ? text.sourceMissing
          : null)
  const canApply = dirty && Boolean(source) && !busy && !context.generating && !mismatch
  const alignKey = alignKeyOf(edits['text-align'] ?? info.styles.textAlign)

  if (compact) {
    return (
      <EditBar
        context={context}
        text={text}
        line={editLine(info)}
        action={
          <Button
            size="sm"
            variant="primary"
            isDisabled={!canApply}
            onPress={() => void apply()}
            data-testid="v3-canvas-edit-apply"
          >
            {busy === 'apply' ? text.applying : text.apply}
          </Button>
        }
      />
    )
  }

  return (
    <aside className="v3-canvas-edit-panel" data-canvas-interactive aria-label={text.panel} data-testid="v3-canvas-edit-panel">
      <div className="v3-canvas-edit-head">
        <span className="v3-canvas-edit-title">{text.panel}</span>
        <code className="v3-canvas-edit-taglet">
          {info.tag}
          {info.id ? `#${info.id}` : ''}
        </code>
        {context.narrow ? <DockToggle labels={context.labels} expanded onToggle={context.toggleDock} /> : null}
      </div>
      <div className="v3-canvas-edit-body">
        <p className="v3-canvas-edit-hint">{text.styleHint}</p>
        {note ? (
          <p className="v3-canvas-edit-note" role="status" data-testid="v3-canvas-edit-note">
            {note}
          </p>
        ) : null}
        {problem ? (
          <p className="v3-canvas-edit-problem" role="alert" data-testid="v3-canvas-edit-problem">
            {problem}
          </p>
        ) : null}
        {applied ? (
          <p className="v3-canvas-edit-note" role="status" data-testid="v3-canvas-edit-applied">
            {text.applied}
          </p>
        ) : null}

        <FieldGroup title={text.text}>
          {sourceReady && leaf ? (
            <TextArea
              className="v3-canvas-edit-wide"
              label={text.text}
              rows={2}
              value={textValue}
              onChange={(value) => {
                setTextEdit(value)
                setApplied(false)
              }}
              data-testid="v3-canvas-edit-text"
            />
          ) : (
            <p className="v3-canvas-edit-note v3-canvas-edit-wide" data-testid="v3-canvas-edit-text-note">
              {sourceReady ? text.textChildren : text.sourceLoading}
            </p>
          )}
          {imageShown ? (
            <>
              <TextField
                label={text.imageSource}
                className="v3-canvas-edit-wide"
                value={attributeEdits.src ?? initialAttribute('src')}
                onChange={(value) => setAttribute('src', value)}
                data-testid="v3-canvas-edit-src"
              />
              <TextField
                label={text.imageAlt}
                className="v3-canvas-edit-wide"
                value={attributeEdits.alt ?? initialAttribute('alt')}
                onChange={(value) => setAttribute('alt', value)}
                data-testid="v3-canvas-edit-alt"
              />
            </>
          ) : null}
          {hrefShown && !imageShown ? (
            <TextField
              label={text.link}
              className="v3-canvas-edit-wide"
              value={attributeEdits.href ?? initialAttribute('href')}
              onChange={(value) => setAttribute('href', value)}
              data-testid="v3-canvas-edit-href"
            />
          ) : null}
        </FieldGroup>

        <FieldGroup title={text.typography}>
          {STYLE_FIELDS.slice(2, 6).map((field) => (
            <TextField
              key={field.property}
              label={field.label(text)}
              value={edits[field.property] ?? field.initial(info)}
              onChange={(value) => setStyle(field.property, value, field.initial(info))}
              data-testid={`v3-canvas-edit-${field.property}`}
            />
          ))}
          <Select
            label={text.align}
            selectedKey={alignKey}
            onSelectionChange={(key) => {
              if (key === null) return
              setStyle('text-align', String(key), info.styles.textAlign)
            }}
            data-testid="v3-canvas-edit-text-align"
          >
            {alignItems(text).map((item) => (
              <ListBoxItem key={item.key} id={item.key} textValue={item.label}>
                {item.label}
              </ListBoxItem>
            ))}
          </Select>
        </FieldGroup>

        <FieldGroup title={text.colors}>
          {STYLE_FIELDS.slice(0, 2).map((field) => (
            <TextField
              key={field.property}
              label={
                <span className="v3-canvas-edit-label">
                  <span
                    className="v3-canvas-edit-swatch"
                    style={{ background: edits[field.property] ?? field.initial(info) }}
                    aria-hidden
                  />
                  {field.label(text)}
                </span>
              }
              value={edits[field.property] ?? field.initial(info)}
              onChange={(value) => setStyle(field.property, value, field.initial(info))}
              data-testid={`v3-canvas-edit-${field.property}`}
            />
          ))}
        </FieldGroup>

        <FieldGroup title={text.spacing}>
          {STYLE_FIELDS.slice(6).map((field) => (
            <TextField
              key={field.property}
              label={field.label(text)}
              value={edits[field.property] ?? field.initial(info)}
              onChange={(value) => setStyle(field.property, value, field.initial(info))}
              data-testid={`v3-canvas-edit-${field.property}`}
            />
          ))}
        </FieldGroup>
      </div>
      <div className="v3-canvas-edit-foot">
        <Button size="sm" variant="primary" isDisabled={!canApply} onPress={() => void apply()} data-testid="v3-canvas-edit-apply">
          {busy === 'apply' ? text.applying : text.apply}
        </Button>
        <Button size="sm" variant="secondary" isDisabled={!dirty || Boolean(busy)} onPress={discard} data-testid="v3-canvas-edit-discard">
          {text.discard}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!undoHash || Boolean(busy)}
          onPress={() => void undo()}
          data-testid="v3-canvas-edit-undo"
        >
          {text.undo}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={Boolean(busy)}
          onPress={reloadFrame}
          data-testid="v3-canvas-edit-refresh"
        >
          {text.refresh}
        </Button>
      </div>
    </aside>
  )
}

export const editTool: CanvasTool = {
  id: 'edit',
  icon: SlidersHorizontal,
  label: (labels) => editText(labels.lang).tool,
  shortcut: 'e',
  frameInput: 'bridge',
  Overlay: EditOverlay,
  Panel: EditPanel
}
