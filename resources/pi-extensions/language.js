import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendReminder } from './request-reminder.js'

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

const REMINDERS = {
  'zh-CN': '<system-reminder>思考过程改回简体中文（用户设定的语言），代码、命令和标识符保持原样。</system-reminder>',
  'en-US': '<system-reminder>Keep the thinking process in English (the user\'s language setting); code, commands and identifiers stay as they are.</system-reminder>'
}
export const DRIFT_MIN_LETTERS = 200
export const DRIFT_COOLDOWN = 4

export function languageReminder(lang) {
  return REMINDERS[lang] ?? null
}

export function thinkingDrifted(lang, text) {
  const source = String(text ?? '').replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
  const cjk = (source.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  const latin = (source.match(/[A-Za-z]/g) ?? []).length
  if (lang === 'zh-CN') return latin >= DRIFT_MIN_LETTERS && cjk < latin * 0.05
  if (lang === 'en-US') return cjk >= DRIFT_MIN_LETTERS / 2 && cjk > latin * 0.5
  return false
}

export function thinkingText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter((part) => part?.type === 'thinking').map((part) => String(part.thinking ?? '')).join('\n')
}

function registerDriftReminder(pi) {
  let pending = false
  let sinceReminder = DRIFT_COOLDOWN
  pi.on('message_end', (event) => {
    const message = event?.message
    if (String(message?.role ?? '') !== 'assistant') return
    sinceReminder += 1
    const lang = language()
    if (sinceReminder >= DRIFT_COOLDOWN && thinkingDrifted(lang, thinkingText(message))) pending = true
  })
  pi.on('before_provider_request', (event) => {
    if (!pending) return undefined
    const text = languageReminder(language())
    const next = text ? appendReminder(event?.payload, text) : undefined
    pending = false
    if (!next) return undefined
    sinceReminder = 0
    trace('drift_reminder', {})
    return next
  })
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
  registerDriftReminder(pi)
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
