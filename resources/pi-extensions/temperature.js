import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function settingsFile() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

function temperatureFor(model) {
  if (!model?.provider || !model?.id) return undefined
  try {
    const table = JSON.parse(readFileSync(settingsFile(), 'utf8'))?.temperatureByModel
    const value = table?.[`${model.provider}/${model.id}`]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined
  } catch {
    return undefined
  }
}

const OFF_WORDS = new Set(['none', 'off', 'disabled'])

function effortOn(value) {
  if (!value) return false
  if (typeof value === 'string') return !OFF_WORDS.has(value.toLowerCase())
  if (typeof value === 'object') return value.enabled !== false && effortOn(value.effort ?? value.level ?? true)
  return true
}

function reasoningRequested(payload) {
  const thinking = payload.thinking
  if (thinking && typeof thinking === 'object' ? thinking.type !== 'disabled' : effortOn(thinking)) return true
  if (effortOn(payload.reasoning_effort) || effortOn(payload.reasoning)) return true
  const thinkingConfig = payload.generationConfig?.thinkingConfig
  return !!thinkingConfig && thinkingConfig.thinkingBudget !== 0
}

export default function temperatureExtension(pi) {
  pi.on('before_provider_request', (event, ctx) => {
    const payload = event?.payload
    if (!payload || typeof payload !== 'object') return
    const temperature = temperatureFor(ctx?.model)
    if (temperature === undefined || reasoningRequested(payload)) return
    return { ...payload, temperature }
  })
}
