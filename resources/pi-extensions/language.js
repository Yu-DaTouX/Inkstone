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
    return '推理（思考过程）、工具调用之间的进度短句和最终回复都必须使用简体中文：即使用户用其他语言提问、工具结果或系统提示是英文，也不要改用英文；代码、命令、路径和标识符保持原样。例外：工作目录的项目指令（如 AGENTS.md、CLAUDE.md）规定了与用户沟通的语言时，按项目指令来。'
  }
  if (lang === 'en-US') {
    return 'Your reasoning (the thinking process), the short progress lines between tool calls and the final reply must all be in English: do not switch language even if the user writes in another language or tool output is in Chinese; code, commands, paths and identifiers stay as they are. Exception: when the project instructions in the working directory (such as AGENTS.md or CLAUDE.md) set a language for talking with the user, follow the project instructions instead.'
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
    const lang = language()
    const text = languageSystemPrompt(lang)
    trace('start', { lang, injected: !!text, baseLen: String(event?.systemPrompt ?? '').length })
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
