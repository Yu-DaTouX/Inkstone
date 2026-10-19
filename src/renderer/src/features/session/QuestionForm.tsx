import { useState, type JSX } from 'react'
import { useT } from '../../i18n'
import type { QuestionField } from '../../../../shared/question-form'
import { Button, Input, Slider, TextArea, TextField } from '../../ui'

type Value = string | string[]

export function QuestionForm({ fields, busy, submitLabel, onSubmit, onSkip }: {
  fields: QuestionField[]
  busy: boolean
  submitLabel: string
  onSubmit: (json: string) => void
  onSkip: () => void
}): JSX.Element {
  const t = useT()
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.kind === 'multi' ? [] : f.kind === 'range' ? String(f.min ?? 0) : '']))
  )
  const [other, setOther] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<string[]>([])

  const set = (name: string, value: Value): void => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setMissing((prev) => prev.filter((n) => n !== name))
  }

  const collect = (): Record<string, unknown> => Object.fromEntries(fields.map((f) => {
    const own = other[f.name]?.trim()
    const v = values[f.name]
    if (f.kind === 'multi') return [f.name, own ? [...(v as string[]), own] : v]
    if (f.kind === 'choice') return [f.name, own || v]
    if (f.kind === 'number' || f.kind === 'range') return [f.name, v === '' ? null : Number(v)]
    return [f.name, v]
  }))

  const submit = (): void => {
    const data = collect()
    const empty = fields.filter((f) => {
      if (f.optional) return false
      const v = data[f.name]
      return v === null || v === '' || (Array.isArray(v) && v.length === 0)
    }).map((f) => f.name)
    if (empty.length) { setMissing(empty); return }
    onSubmit(JSON.stringify(data))
  }

  return (
    <div className="v3-qform" data-testid="v3-question-form">
      {fields.map((f) => {
        const v = values[f.name]
        const bad = missing.includes(f.name)
        const errId = `v3qf-${f.name}-err`
        const describedBy = bad ? errId : undefined
        return (
          <div key={f.name} className={`v3-qfield${bad ? ' missing' : ''}`}>
            {f.kind === 'range' ? (
              <span className="v3-qfield-label">
                {f.label}{f.optional ? <span className="v3-qoptional">{t('qf.optional')}</span> : null}
              </span>
            ) : (
              <label className="v3-qfield-label" htmlFor={`v3qf-${f.name}`}>
                {f.label}{f.optional ? <span className="v3-qoptional">{t('qf.optional')}</span> : null}
              </label>
            )}

            {f.kind === 'choice' || f.kind === 'multi' ? (
              <>
                <div className="v3-qoptions" role="group" aria-label={f.label} aria-describedby={bad ? errId : undefined}>
                  {f.options!.map((raw) => {
                    const o = typeof raw === 'string' ? { label: raw, description: undefined } : raw
                    const on = f.kind === 'multi' ? (v as string[]).includes(o.label) : v === o.label
                    return (
                      <button
                        key={o.label}
                        type="button"
                        className={`v3-qoption${on ? ' on' : ''}`}
                        aria-pressed={on}
                        disabled={busy}
                        onClick={() => {
                          if (f.kind === 'multi') set(f.name, on ? (v as string[]).filter((x) => x !== o.label) : [...(v as string[]), o.label])
                          else {
                            setOther((prev) => ({ ...prev, [f.name]: '' }))
                            set(f.name, on ? '' : o.label)
                          }
                        }}
                      >
                        <span className="v3-qoption-label">{o.label}</span>
                        {o.description ? <span className="v3-qoption-desc">{o.description}</span> : null}
                        <span className="v3-qcheck" aria-hidden />
                      </button>
                    )
                  })}
                </div>
                <TextField
                  className="v3-qother"
                  id={`v3qf-${f.name}`}
                  aria-label={`${f.label} (${t('q.customReply')})`}
                  placeholder={t('q.customReply')}
                  isInvalid={bad}
                  aria-describedby={describedBy}
                  value={other[f.name] ?? ''}
                  isDisabled={busy}
                  onChange={(text) => {
                    setOther((prev) => ({ ...prev, [f.name]: text }))
                    if (f.kind === 'choice' && text.trim()) set(f.name, '')
                    else setMissing((prev) => prev.filter((n) => n !== f.name))
                  }}
                />
              </>
            ) : f.kind === 'range' ? (
              <Slider
                aria-label={f.label}
                minValue={f.min ?? 0}
                maxValue={f.max ?? 100}
                step={f.step ?? 1}
                value={Number(v)}
                isDisabled={busy}
                isInvalid={bad}
                showValue
                thumbLabels={[f.label]}
                aria-describedby={describedBy}
                onChange={(next) => set(f.name, String(Array.isArray(next) ? next[0] : next))}
              />
            ) : f.kind === 'text' ? (
              <TextArea id={`v3qf-${f.name}`} aria-label={f.label} rows={2} placeholder={f.placeholder} value={v as string} isDisabled={busy} isInvalid={bad} aria-describedby={describedBy} onChange={(text) => set(f.name, text)} />
            ) : (
              <TextField
                id={`v3qf-${f.name}`}
                aria-label={f.label}
                type={f.kind === 'date' ? 'date' : 'number'}
                value={v as string}
                isDisabled={busy}
                isInvalid={bad}
                aria-describedby={describedBy}
                onChange={(text) => set(f.name, text)}
              >
                <Input className="ui-input" min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} />
              </TextField>
            )}
            {bad ? <span className="v3-qerror" id={errId} role="alert">{t('qf.required')}</span> : null}
          </div>
        )
      })}
      <div className="v3-qfoot">
        <Button size="sm" isDisabled={busy} onPress={onSkip} data-testid="v3-question-form-skip">{t('q.skip')}</Button>
        <span className="v3-code-sp" />
        <Button size="sm" variant="primary" isDisabled={busy} onPress={submit} data-testid="v3-question-form-submit">{submitLabel}</Button>
      </div>
    </div>
  )
}
