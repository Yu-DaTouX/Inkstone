import { Check, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { IconButton, TextArea } from '../../ui'
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
}

export function DiffAnnotationEditor({
  labels,
  range,
  value,
  onChange,
  onSubmit,
  onCancel
}: DiffAnnotationEditorProps): ReactElement {
  const canSubmit = value.trim().length > 0
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
        onChange={onChange}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.stopPropagation()
            if (canSubmit) onSubmit()
          }
        }}
      />
      <span className="diff-annotation__actions">
        <span className="diff-annotation__hint">{labels.hint}</span>
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
