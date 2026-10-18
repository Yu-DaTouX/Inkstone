import { useEffect, useRef, type ReactElement } from 'react'
import type { ModelBrand } from '../../../shared/model-brand'
import { botSeed, mountBot, type BotHandle } from './model-bot/clock'
import type { BotActivity, BotMood, BotTool } from './model-bot/draw'

export type { BotActivity, BotMood, BotTool } from './model-bot/draw'

export interface ModelBotProps {
  brand: ModelBrand
  mood: BotMood
  size?: number
  seedKey?: string
  tool?: BotActivity | null
  cornerBadge?: boolean
  className?: string
}

function activityOf(look: BotTool | undefined, id: string | undefined): BotActivity | null {
  return look ? { look, id: id ?? '' } : null
}

export function ModelBot({ brand, mood, size = 28, seedKey = '', tool, cornerBadge = false, className }: ModelBotProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<BotHandle | null>(null)
  const toolLook = tool?.look
  const toolId = tool?.id
  const latest = useRef({ brand, mood, size, seedKey, toolLook, toolId, cornerBadge })
  latest.current = { brand, mood, size, seedKey, toolLook, toolId, cornerBadge }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const { brand: b, mood: m, size: s, seedKey: k, toolLook: look, toolId: id, cornerBadge: corner } = latest.current
    const handle = mountBot(canvas, { brand: b, mood: m, size: s, seed: botSeed(k), tool: activityOf(look, id), corner })
    handleRef.current = handle
    return () => {
      handle.dispose()
      handleRef.current = null
    }
  }, [])

  useEffect(() => {
    handleRef.current?.update({ brand, mood, size, tool: activityOf(toolLook, toolId) })
  }, [brand, mood, size, toolLook, toolId])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      data-brand={brand}
      data-mood={mood}
      data-tool={toolLook}
      aria-hidden="true"
      style={{ width: size, height: size }}
    />
  )
}
