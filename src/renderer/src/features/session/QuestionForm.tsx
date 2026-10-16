import { useState, type JSX } from 'react'
import { useT } from '../../i18n'
import type { QuestionField } from '../../../../shared/question-form'
import { Button } from '../../ui'

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
        return (
          <div key={f.name} className={`v3-qfield${bad ? ' missing' : ''}`}>
            <label className="v3-qfield-label" htmlFor={`v3qf-${f.name}`}>
              {f.label}{f.optional ? <span className="v3-qoptional">{t('qf.optional')}</span> : null}
            </label>

            {f.kind === 'choice' || f.kind === 'multi' ? (
              <>
                <div className="v3-qoptions" role="group" aria-label={f.label}>
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
                <input
                  className="v3-input v3-qother"
                  id={`v3qf-${f.name}`}
                  placeholder={t('q.customReply')}
                  value={other[f.name] ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const text = e.target.value
                    setOther((prev) => ({ ...prev, [f.name]: text }))
                    if (f.kind === 'choice' && text.trim()) set(f.name, '')
                    else setMissing((prev) => prev.filter((n) => n !== f.name))
                  }}
                />
              </>
            ) : f.kind === 'range' ? (
              <div className="v3-qrange">
                <input id={`v3qf-${f.name}`} type="range" min={f.min} max={f.max} step={f.step ?? 1} value={v as string} disabled={busy} onChange={(e) => set(f.name, e.target.value)} />
                <span className="v3-qrange-value">{v as string}</span>
              </div>
            ) : f.kind === 'text' ? (
              <textarea id={`v3qf-${f.name}`} className="v3-input v3-textarea" rows={2} placeholder={f.placeholder} value={v as string} disabled={busy} onChange={(e) => set(f.name, e.target.value)} />
            ) : (
              <input
                id={`v3qf-${f.name}`}
                className="v3-input"
                type={f.kind === 'date' ? 'date' : 'number'}
                min={f.min}
                max={f.max}
                step={f.step}
                placeholder={f.placeholder}
                value={v as string}
                disabled={busy}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
            {bad ? <span className="v3-qerror" role="alert">{t('qf.required')}</span> : null}
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
