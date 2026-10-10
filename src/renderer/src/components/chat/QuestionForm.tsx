import { useState } from 'react'
import { useT } from '../../i18n'
import { Button } from '../ui'
import { BlockIcon } from './VisualParts'
import type { QuestionField } from '../../../../shared/question-form'

type Value = string | string[]

/**
 * 问题面板里的表单形态（`yan question ask` 带 fields）：一次问清几项。
 *
 * 选择题是整行可点的卡片（单选再点一次取消），下面一行可以另写；
 * 日期、数字、滑块用原生输入；必填项没填时就地提示，不提交。答案按 name 打包成 JSON 交回宿主。
 */
export function QuestionForm({ fields, busy, submitLabel, onSubmit, onSkip }: {
  fields: QuestionField[]
  busy: boolean
  submitLabel: string
  onSubmit: (json: string) => void
  onSkip: () => void
}) {
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
    <div className="qform" data-testid="question-form">
      {fields.map((f) => {
        const v = values[f.name]
        const bad = missing.includes(f.name)
        return (
          <div key={f.name} className={`qform-field${bad ? ' missing' : ''}`}>
            <label className="qform-label" htmlFor={`qf-${f.name}`}>{f.label}{f.optional ? <span className="qform-optional">{t('qf.optional')}</span> : null}</label>
            {f.kind === 'choice' || f.kind === 'multi' ? (
              <>
                <div className="qform-options" role={f.kind === 'multi' ? 'group' : 'radiogroup'} aria-label={f.label}>
                  {f.options!.map((raw) => {
                    /* 宿主已规范化成对象；兼容直接给文字的旧请求 */
                    const o = typeof raw === 'string' ? { label: raw as string, description: undefined, icon: undefined } : raw
                    const on = f.kind === 'multi' ? (v as string[]).includes(o.label) : v === o.label
                    return (
                      <button key={o.label} type="button" className={`qform-option${on ? ' on' : ''}`} aria-pressed={on} disabled={busy}
                        onClick={() => set(f.name, f.kind === 'multi' ? (on ? (v as string[]).filter((x) => x !== o.label) : [...(v as string[]), o.label]) : on ? '' : o.label)}>
                        <BlockIcon name={o.icon} size={14} className="qform-option-icon" />
                        <span className="qform-option-text">
                          <span className="qform-option-label">{o.label}</span>
                          {o.description ? <span className="qform-option-desc">{o.description}</span> : null}
                        </span>
                        <span className="qform-check" aria-hidden />
                      </button>
                    )
                  })}
                </div>
                <input className="ui-input qform-other" id={`qf-${f.name}`} placeholder={t('q.customReply')} value={other[f.name] ?? ''} disabled={busy}
                  onChange={(e) => { setOther((prev) => ({ ...prev, [f.name]: e.target.value })); setMissing((prev) => prev.filter((n) => n !== f.name)) }} />
              </>
            ) : f.kind === 'range' ? (
              <div className="qform-range">
                <input id={`qf-${f.name}`} type="range" min={f.min} max={f.max} step={f.step ?? 1} value={v as string} disabled={busy} onChange={(e) => set(f.name, e.target.value)} />
                <span className="qform-range-value">{v as string}</span>
              </div>
            ) : f.kind === 'text' ? (
              <textarea id={`qf-${f.name}`} className="ui-input qform-text" rows={2} placeholder={f.placeholder} value={v as string} disabled={busy} onChange={(e) => set(f.name, e.target.value)} />
            ) : (
              <input id={`qf-${f.name}`} className={`ui-input${f.kind === 'number' ? ' num' : ''}`} type={f.kind === 'date' ? 'date' : 'number'}
                min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} value={v as string} disabled={busy} onChange={(e) => set(f.name, e.target.value)} />
            )}
            {bad ? <span className="qform-error" role="alert">{t('qf.required')}</span> : null}
          </div>
        )
      })}
      <div className="qpanel-foot">
        <Button disabled={busy} onClick={onSkip} data-testid="question-panel-skip">{t('q.skip')}</Button>
        <span className="spacer" />
        <Button variant="primary" disabled={busy} onClick={submit} data-testid="question-panel-submit">{submitLabel}</Button>
      </div>
    </div>
  )
}
