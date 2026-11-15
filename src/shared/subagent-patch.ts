import type { SubagentPatch } from './ipc'
import type { UIMessage } from './ui-message'

type TranscriptPatch = Pick<SubagentPatch, 'run' | 'transcriptFrom' | 'textFrom' | 'thinkingFrom'>

export function mergeSubagentTranscript(previous: readonly UIMessage[], patch: TranscriptPatch): UIMessage[] | null {
  const from = patch.transcriptFrom
  const incoming = patch.run.transcript
  if (from < 0 || from > previous.length) return null
  const { textFrom, thinkingFrom } = patch
  if (textFrom === undefined && thinkingFrom === undefined) return [...previous.slice(0, from), ...incoming]
  const base = previous[from]
  const head = incoming[0]
  if (!base || !head || base.id !== head.id) return null
  if ((textFrom ?? 0) > base.text.length || (thinkingFrom ?? 0) > (base.thinking ?? '').length) return null
  const first: UIMessage = { ...head }
  if (textFrom !== undefined) first.text = base.text.slice(0, textFrom) + head.text
  if (thinkingFrom !== undefined) first.thinking = (base.thinking ?? '').slice(0, thinkingFrom) + (head.thinking ?? '')
  return [...previous.slice(0, from), first, ...incoming.slice(1)]
}
