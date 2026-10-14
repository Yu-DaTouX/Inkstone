/*
 * 砚内置「采样温度」扩展 —— 把模型菜单里为当前模型设的温度写进请求。
 *
 * 只在用户给这个模型设过温度时才动请求；没设过就原样返回，供应商用自己的默认值。
 * 读文件而不是环境变量：温度可以在会话中途调整，下一次请求就生效（与 response-detail.js 同一套做法）。
 *
 * 开了思考 / 推理的请求直接放过：Anthropic 开思考时只接受默认温度，
 * OpenAI 推理模型会拒绝 temperature 参数，硬塞只会让整轮请求失败。
 */

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

/** pi 在「思考关」时也会写一个关闭值（如 reasoning_effort: "none"），这些不算开了推理。 */
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
