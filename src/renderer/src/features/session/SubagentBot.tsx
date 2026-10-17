import type { JSX } from 'react'
import { ModelBot, type BotMood } from '../../patterns/ModelBot'
import { modelBrand } from '../../../../shared/model-brand'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { SubagentLineModel } from './turn-lines'
import { subagentActiveTool } from './subagent-tool'

export function subagentBotMood(model: Pick<SubagentLineModel, 'phase' | 'outcomeKey'>): BotMood {
  const kind = model.phase?.kind
  if (kind === 'needs-you' || kind === 'stalled') return 'ask'
  if (kind === 'queued') return 'wake'
  if (kind === 'failed') return 'fail'
  if (kind === 'stopped') return 'rest'
  if (kind === 'running') return model.outcomeKey === 'starting' ? 'wake' : 'work'
  switch (model.outcomeKey) {
    case 'starting':
      return 'wake'
    case 'running':
    case 'wrapUp':
      return 'work'
    case 'review':
    case 'conflict':
    case 'timeout':
    case 'budget':
      return 'ask'
    case 'failed':
    case 'dismissed':
      return 'fail'
    case 'stopped':
      return 'rest'
    default:
      return 'done'
  }
}

export function SubagentBot({ run, snapshot, model, size = 28 }: { run: SubagentRun; snapshot?: RunSnapshot; model: SubagentLineModel; size?: number }): JSX.Element {
  const mood = subagentBotMood(model)
  return (
    <ModelBot
      brand={modelBrand(snapshot?.model ?? run.model)}
      mood={mood}
      size={size}
      seedKey={run.id}
      tool={mood === 'work' ? subagentActiveTool(run, snapshot) : null}
      className="v3-subagent-bot"
    />
  )
}
