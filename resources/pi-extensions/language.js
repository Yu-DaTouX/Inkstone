import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function settingsFile() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

function language() {
  try {
    const j = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    const v = j?.lang
    return v === 'zh-CN' || v === 'en-US' ? v : null
  } catch {
    return null
  }
}

export function languageSystemPrompt(lang) {
  if (lang === 'zh-CN') {
    return '推理（思考过程）与回复都必须使用简体中文：即使用户用其他语言提问、工具结果是英文，思考过程里也不要改用英文。'
  }
  if (lang === 'en-US') {
    return 'Both your reasoning (the thinking process) and the final reply must be in English: do not switch language inside the thinking process, even if the user writes in another language or tool output is in Chinese.'
  }
  return null
}

function trace(hook, extra) {
  const file = process.env.YAN_LANG_EXT_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ ts: Date.now(), hook, ...extra }) + '\n')
  } catch {
  }
}

export default function languageExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const text = languageSystemPrompt(language())
    trace('start', { lang: language(), injected: !!text, baseLen: String(event?.systemPrompt ?? '').length })
    if (!text) return
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_language = text
      return
    }
    return { systemPrompt: base ? `${base}\n\n${text}` : text }
  })
}
