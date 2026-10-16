import type { RunPhase } from '../../../../shared/runs'
import { formatDuration, phaseDetail, phaseWord, type RunLang } from '../../state/runs-v3'

export interface RailText {
  stalledTitle: string
  stop: string
  autoNote: string
  retryIn: string
  stalledFor: string
}

const ZH: RailText = {
  stalledTitle: '运行停滞',
  stop: '停止',
  autoNote: '停滞只是更早的可见信号，不会自动续跑或停止；是否继续由你决定。',
  retryIn: '{s} 后重试',
  stalledFor: '已停滞 {s}'
}

const EN: RailText = {
  stalledTitle: 'Run stalled',
  stop: 'Stop',
  autoNote: 'Stalling is only an early signal. Nothing auto-resumes or stops; the next step is yours.',
  retryIn: 'retrying in {s}',
  stalledFor: 'stalled for {s}'
}

export function railText(lang: string): RailText {
  return lang === 'en-US' ? EN : ZH
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(value)
  return out
}

export interface StallReason {
  word: string
  detail: string | null
  timing: string
}

export function stallReason(lang: RunLang, phase: RunPhase, now: number): StallReason | null {
  if (phase.kind !== 'stalled') return null
  const text = railText(lang)
  const resumeAt = phase.retry?.resumeAt
  const timing =
    resumeAt !== undefined && resumeAt > now
      ? fill(text.retryIn, { s: formatDuration(resumeAt - now, lang) })
      : fill(text.stalledFor, { s: formatDuration(Math.max(0, now - phase.since), lang) })
  return { word: phaseWord(lang, phase), detail: phaseDetail(lang, phase), timing }
}
