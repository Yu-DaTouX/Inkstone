import { Check, X } from 'lucide-react'
import { useId, type ReactElement } from 'react'
import { IconButton, TextArea } from '../../ui'
import { annotationKeyAction } from './annotation-keys'
import './diff-annotation.css'

export interface DiffAnnotateLabels {
  add: string
  line: (line: number) => string
  lines: (start: number, end: number) => string
  placeholder: string
  submit: string
  cancel: string
  hint: string
}

export interface DiffAnnotationPayload {
  start: number
  end: number
  code: string
  text: string
}

export interface DiffAnnotate {
  labels: DiffAnnotateLabels
  onSubmit: (annotation: DiffAnnotationPayload) => void
}

export interface DiffAnnotationEditorProps {
  labels: DiffAnnotateLabels
  range: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  hint?: string
}

export function DiffAnnotationEditor({
  labels,
  range,
  value,
  onChange,
  onSubmit,
  onCancel,
  hint
}: DiffAnnotationEditorProps): ReactElement {
  const canSubmit = value.trim().length > 0
  const hintId = useId()
  return (
    <div
      className="diff-annotation"
      data-testid="diff-annotation"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="diff-annotation__label">{range}</span>
      <TextArea
        className="diff-annotation__field"
        size="sm"
        rows={2}
        autoFocus
        value={value}
        placeholder={labels.placeholder}
        aria-label={range}
        aria-describedby={hintId}
        onChange={onChange}
        onKeyDown={(event) => {
          const action = annotationKeyAction({
            key: event.key,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
            keyCode: event.nativeEvent.keyCode
          })
          if (!action) return
          event.preventDefault()
          event.stopPropagation()
          if (action === 'cancel') onCancel()
          else if (canSubmit) onSubmit()
        }}
      />
      <span className="diff-annotation__actions">
        <span className="diff-annotation__hint" id={hintId}>
          {hint ?? labels.hint}
        </span>
        <IconButton size="xs" aria-label={labels.submit} tooltip={labels.submit} isDisabled={!canSubmit} onPress={onSubmit}>
          <Check size={12} aria-hidden="true" />
        </IconButton>
        <IconButton size="xs" aria-label={labels.cancel} tooltip={labels.cancel} onPress={onCancel}>
          <X size={12} aria-hidden="true" />
        </IconButton>
      </span>
    </div>
  )
}
