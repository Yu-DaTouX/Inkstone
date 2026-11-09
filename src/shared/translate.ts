export const TRANSLATE_SERVICES = ['bing', 'google', 'model'] as const
export type TranslateService = (typeof TRANSLATE_SERVICES)[number]

export const TRANSLATE_TARGETS = ['auto', 'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'] as const
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number]

export const TRANSLATE_MAX_CHARS = 20000

export type TranslateResult =
  | { ok: true; text: string; service: TranslateService; cached: boolean }
  | { ok: false; error: string }

export function isTranslateService(value: unknown): value is TranslateService {
  return typeof value === 'string' && (TRANSLATE_SERVICES as readonly string[]).includes(value)
}

export function isTranslateTarget(value: unknown): value is TranslateTarget {
  return typeof value === 'string' && (TRANSLATE_TARGETS as readonly string[]).includes(value)
}

export function resolveTranslateTarget(target: TranslateTarget | undefined, uiLang: string): Exclude<TranslateTarget, 'auto'> {
  if (target && target !== 'auto') return target
  return uiLang === 'en-US' ? 'en' : 'zh-Hans'
}

export const TRANSLATE_LANGUAGE_NAME: Record<Exclude<TranslateTarget, 'auto'>, string> = {
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean'
}

const GOOGLE_CODE: Record<Exclude<TranslateTarget, 'auto'>, string> = {
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko'
}

export function googleLanguageCode(target: Exclude<TranslateTarget, 'auto'>): string {
  return GOOGLE_CODE[target]
}

export interface TextPiece {
  text: string
  translate: boolean
}

const FENCE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g

export function splitForTranslation(text: string): TextPiece[] {
  const pieces: TextPiece[] = []
  let last = 0
  for (const match of text.matchAll(FENCE)) {
    const start = (match.index ?? 0) + match[1].length
    if (start > last) pieces.push({ text: text.slice(last, start), translate: true })
    const end = (match.index ?? 0) + match[0].length
    pieces.push({ text: text.slice(start, end), translate: false })
    last = end
  }
  if (last < text.length) pieces.push({ text: text.slice(last), translate: true })
  return pieces.filter((piece) => piece.text.length > 0)
}

const PROTECTED = /`[^`\n]+`|https?:\/\/[^\s)）」』>"']+|[A-Za-z]:[\\/][^\s`"'，。；;)）]+|(?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+){2,}/g

export interface Protected {
  text: string
  spans: string[]
}

export function protectSpans(text: string): Protected {
  const spans: string[] = []
  const out = text.replace(PROTECTED, (span) => {
    spans.push(span)
    return `<x${spans.length - 1}/>`
  })
  return { text: out, spans }
}

export function restoreSpans(translated: string, spans: readonly string[]): string | null {
  if (!spans.length) return translated
  let result = translated
  for (let index = 0; index < spans.length; index += 1) {
    const tag = `<x${index}/>`
    const count = result.split(tag).length - 1
    if (count !== 1) return null
    result = result.replace(tag, () => spans[index])
  }
  return /<x\d+\/>/.test(result) ? null : result
}

export function chunkProse(text: string, limit = 1800): string[] {
  const parts = text.split(/(\n{2,})/)
  const out: string[] = []
  let current = ''
  for (const part of parts) {
    if (current.length + part.length > limit && current) {
      out.push(current)
      current = ''
    }
    if (part.length > limit) {
      const sentences = part.match(/[^.!?。！？\n]+[.!?。！？]?\s*|\n/g) ?? [part]
      for (const sentence of sentences) {
        if (current.length + sentence.length > limit && current) {
          out.push(current)
          current = ''
        }
        current += sentence
      }
    } else {
      current += part
    }
  }
  if (current) out.push(current)
  return out
}
