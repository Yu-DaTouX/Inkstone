import type { JSX } from 'react'
import { ModelBot, type BotMood } from '../../patterns/ModelBot'
import { modelBrand } from '../../../../shared/model-brand'
import type { RunModel, RunPhase } from '../../../../shared/runs'
import { subagentToolLook } from '../session/subagent-tool'

const BOT_SIZE = 16

export function SessionBot({
  phase,
  mood,
  model,
  seedKey,
  label
}: {
  phase: RunPhase | null
  mood: BotMood
  model?: RunModel | string
  seedKey: string
  label: string
}): JSX.Element {
  const runningTool = phase?.kind === 'running' ? phase.tool : undefined
  const look = runningTool ? subagentToolLook(runningTool.name, runningTool.label) : null
  return (
    <span className="v3-row-bot" role="img" aria-label={label} title={label} data-mood={mood}>
      <ModelBot
        brand={modelBrand(model)}
        mood={mood}
        size={BOT_SIZE}
        seedKey={seedKey}
        cornerBadge
        tool={mood === 'work' && runningTool && look ? { look, id: runningTool.callId } : null}
      />
    </span>
  )
}
