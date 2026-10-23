export type ArtifactLintLevel = 'must' | 'should'

export interface ArtifactLintFinding {
  level: ArtifactLintLevel
  id: string
  message: string
  snippet?: string
}

const PURPLE_HEXES = [
  '#a855f7', '#9333ea', '#7c3aed', '#6d28d9', '#581c87',
  '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe',
  '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81',
  '#818cf8', '#a5b4fc', '#c7d2fe', '#e0e7ff', '#eef2ff'
]

const BLUE_HEXES = [
  '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a',
  '#60a5fa', '#93c5fd', '#bfdbfe',
  '#0ea5e9', '#0284c7', '#0369a1', '#38bdf8', '#7dd3fc'
]

const CYAN_HEXES = [
  '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63',
  '#22d3ee', '#67e8f9', '#a5f3fc'
]

const AI_DEFAULT_INDIGO = ['#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#8b5cf6', '#7c3aed', '#a855f7']

const SLOP_EMOJI = ['✨', '🚀', '🎯', '⚡', '🔥', '💡', '📈', '🎨', '🛡️', '🌟', '💪', '🎉', '👋', '🙌', '✅', '⭐', '🏆']

const INVENTED_METRIC_PATTERNS = [
  /\b10×\s+(faster|better|easier)\b/i,
  /\b100×\s+(faster|better)\b/i,
  /\b99\.\d+%\s+uptime\b/i,
  /\bzero[- ]downtime\b/i,
  /\b3×\s+more\s+(productive|efficient)\b/i
]

const FILLER_PATTERNS = [
  /\bfeature\s+(one|two|three|1|2|3)\b/i,
  /\blorem\s+ipsum\b/i,
  /\bdolor\s+sit\s+amet\b/i,
  /\bplaceholder\s+text\b/i,
  /\bsample\s+content\b/i
]

const GRADIENT_RE = /(?:repeating-)?(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/gi
const EXTERNAL_RESOURCE_RE = /<(?:img|script|link|source|video|audio|iframe)\b[^>]*\s(?:src|href|srcset|poster)\s*=\s*["']\s*(?:https?:)?\/\/[^"']+["']|url\(\s*["']?(?:https?:)?\/\/[^)"']+["']?\s*\)|@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/[^;"')]+/i
const MAX_RAW_HEX_OUTSIDE_ROOT = 12
const MAX_INLINE_ACCENT_USES = 6
const MIN_CAPS_TRACKING_EM = 0.06
const DISPLAY_CAPS_MIN_PX = 48
const SNIPPET_MAX = 120

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const hasHex = (text: string, hexes: string[]): string | undefined =>
  hexes.find((hex) => new RegExp(`${escapeRe(hex)}(?![0-9a-f])`, 'i').test(text))

const styleBlocks = (html: string): string[] =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, ''))

const withoutRootRules = (text: string): string => text.replace(/[^{}]*:root[^{}]*\{[^{}]*\}/gi, '')

function capsTrackingAdequate(declarations: string): boolean {
  const fontSize = /font-size\s*:\s*([^;]+)/i.exec(declarations)?.[1]?.trim() ?? ''
  if (/clamp\(|vw|vmin|vmax/i.test(fontSize)) return true
  const fontPx = /^([\d.]+)px/i.exec(fontSize)
  if (fontPx && Number(fontPx[1]) >= DISPLAY_CAPS_MIN_PX) return true
  const spacing = /letter-spacing\s*:\s*([^;]+)/i.exec(declarations)?.[1]?.trim()
  if (!spacing) return false
  if (/var\(|calc\(/i.test(spacing)) return true
  const em = /^(-?[\d.]+)r?em\b/i.exec(spacing)
  if (em) return Number(em[1]) >= MIN_CAPS_TRACKING_EM
  const px = /^(-?[\d.]+)px\b/i.exec(spacing)
  if (px) return fontPx ? Number(px[1]) / Number(fontPx[1]) >= MIN_CAPS_TRACKING_EM : Number(px[1]) >= 1
  return false
}

export function lintArtifactHtml(rawHtml: string): ArtifactLintFinding[] {
  const findings: ArtifactLintFinding[] = []
  if (!rawHtml) return findings
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '')
  const css = styleBlocks(html)
  const gradients = [...html.matchAll(GRADIENT_RE)].map((match) => match[0])

  const purpleGradient = gradients.find((gradient) => hasHex(gradient, PURPLE_HEXES) || /\b(purple|violet)\b/i.test(gradient))
  if (purpleGradient) {
    findings.push({
      level: 'must',
      id: 'purple-gradient',
      message: '紫色 / 靛蓝渐变是最典型的 AI 默认长相：换成纯色底（var(--bg) / var(--surface)），或只用风格牌强调色的单一明度。',
      snippet: clip(purpleGradient)
    })
  } else {
    const trustGradient = gradients.find((gradient) =>
      (hasHex(gradient, BLUE_HEXES) || /\bblue\b/i.test(gradient)) && (hasHex(gradient, CYAN_HEXES) || /\bcyan\b/i.test(gradient)))
    if (trustGradient) {
      findings.push({
        level: 'must',
        id: 'trust-gradient',
        message: '蓝→青两段「信任感」渐变是 SaaS 首屏套路：换成纯色底或风格牌里的单一颜色。',
        snippet: clip(trustGradient)
      })
    }
    const indigo = hasHex(withoutRootRules(html), AI_DEFAULT_INDIGO)
    if (indigo) {
      findings.push({
        level: 'must',
        id: 'ai-default-indigo',
        message: `直接写了模型默认强调色 ${indigo}：改用风格牌的 var(--accent)；确实要这个颜色就把它定义成 :root 里的 --accent 再引用。`,
        snippet: indigo
      })
    }
  }

  for (const emoji of SLOP_EMOJI) {
    if (!html.includes(emoji)) continue
    const match = new RegExp(`<(?:h[1-6]|button|li|span class="[^"]*icon[^"]*")[^>]*>[^<]*${escapeRe(emoji)}`, 'i').exec(html)
    if (match) {
      findings.push({
        level: 'must',
        id: 'emoji-icon',
        message: `把 emoji「${emoji}」当成标题、按钮或列表的图标：换成内联 SVG 线性图标（1.6–1.8px 描边，currentColor）或直接去掉。`,
        snippet: clip(match[0])
      })
      break
    }
  }

  const leftAccent = /[.#][\w-]+[^{}]*\{[^}]*border-left\s*:\s*\d+px\s+solid\s+[^;]+;[^}]*border-radius\s*:\s*[1-9]/i.exec(css.join('\n'))
  if (leftAccent) {
    findings.push({
      level: 'must',
      id: 'left-accent-card',
      message: '圆角卡片加彩色左边框是典型的 AI 仪表盘卡片：圆角和左边框去掉一个。',
      snippet: clip(leftAccent[0])
    })
  }

  for (const pattern of INVENTED_METRIC_PATTERNS) {
    const match = pattern.exec(html)
    if (match) {
      findings.push({
        level: 'must',
        id: 'invented-metric',
        message: `疑似编造的指标「${match[0]}」：没有来源就删掉，或换成标明可替换的占位。`,
        snippet: match[0]
      })
      break
    }
  }

  for (const pattern of FILLER_PATTERNS) {
    const match = pattern.exec(html)
    if (match) {
      findings.push({
        level: 'must',
        id: 'filler-copy',
        message: `无意义的填充文案「${match[0]}」：写和主题相关的文案，或用一眼能看出要替换的占位（如「活动名称」）。`,
        snippet: match[0]
      })
      break
    }
  }

  const external = EXTERNAL_RESOURCE_RE.exec(html)
  if (external) {
    findings.push({
      level: 'must',
      id: 'external-resource',
      message: '引用了网络上的图片、脚本、样式或字体：砚的沙箱会拦截，页面里会缺东西。改成内联 SVG、data: URI 或系统字体。',
      snippet: clip(external[0])
    })
  }

  const capsRule = css.flatMap((block) => [...block.matchAll(/([^{}]*)\{([^{}]*text-transform\s*:\s*uppercase[^{}]*)\}/gi)])
    .find((match) => !capsTrackingAdequate(match[2] ?? ''))
  const capsInline = capsRule
    ? undefined
    : [...html.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)]
        .find((match) => /text-transform\s*:\s*uppercase/i.test(match[2] ?? '') && !capsTrackingAdequate(match[2] ?? ''))
  if (capsRule || capsInline) {
    findings.push({
      level: 'should',
      id: 'all-caps-no-tracking',
      message: `西文全大写没加字距：同一条规则里加 letter-spacing: 0.08em 左右（不低于 ${MIN_CAPS_TRACKING_EM}em）。${DISPLAY_CAPS_MIN_PX}px 以上的展示大字不查；风格牌另有规定时以牌为准。`,
      snippet: clip(capsRule ? `${(capsRule[1] ?? '').trim()} { ${(capsRule[2] ?? '').trim()} }` : capsInline?.[2] ?? '')
    })
  }

  const rawHexes = css.flatMap((block) => withoutRootRules(block).match(/#[0-9a-f]{3,8}\b/gi) ?? [])
  if (rawHexes.length > MAX_RAW_HEX_OUTSIDE_ROOT) {
    findings.push({
      level: 'should',
      id: 'raw-hex',
      message: `:root 之外散写了 ${rawHexes.length} 个色值：颜色集中写成 :root 里的变量再用 var() 引用，派生色用 color-mix()。`,
      snippet: rawHexes.slice(0, 6).join(' ')
    })
  }

  const inlineAccentUses = (html.replace(/<style[\s\S]*?<\/style>/gi, '').match(/var\(--accent\)/g) ?? []).length
  if (inlineAccentUses > MAX_INLINE_ACCENT_USES) {
    findings.push({
      level: 'should',
      id: 'accent-overuse',
      message: `正文行内用了 ${inlineAccentUses} 次 var(--accent)：每屏强调色最多两处，其余改成 var(--ink) / var(--muted)。`
    })
  }

  return findings
}

export function formatArtifactLint(findings: ArtifactLintFinding[]): string[] {
  return [...findings]
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'must' ? -1 : 1))
    .map((finding) => `[${finding.level === 'must' ? '必须改' : '建议改'}] ${finding.id}：${finding.message}${finding.snippet ? `（片段：${finding.snippet}）` : ''}`)
}
