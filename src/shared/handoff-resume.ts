import type { HandoffPackage } from './handoff'

export const RESUME_ID_TAG = 'yan-handoff-resume'

const RESUME_HEADER = '这是一个**跨会话交接**：上面的对话换了新会话继续，下面是上一个会话留下的交接包。'

const RESUME_FOOTER =
  '请按交接包**继续推进**，不要重新确认已经确认过的信息、不要重做已经完成的部分；先做接下来该做的事。\n' +
  '接手后先跑一次 `yan goal status` 看当前 revision（宿主已经把目标与验收标准带过来了），' +
  '再用 `yan goal report` 把**这一段的**进展与证据登记上 —— 交接包里写的进度是上一段的复述，' +
  '不能当作新的完成证据。'

export function resumeMarker(resumeId: string): string {
  return `[${RESUME_ID_TAG}:${String(resumeId ?? '').trim()}]`
}

function bullet(label: string, items: string[]): string[] {
  if (!items.length) return []
  return [`${label}：`, ...items.map((item) => `- ${item}`)]
}

export function buildResumeText(pkg: HandoffPackage | null | undefined, resumeId: string): string {
  const id = String(resumeId ?? '').trim()
  const lines: string[] = [RESUME_HEADER, '', resumeMarker(id)]
  if (pkg) {
    lines.push('', `用户目标：${pkg.goal}`, `交付物：${pkg.deliverable}`)
    lines.push(...bullet('约束与授权', pkg.constraints))
    lines.push(...bullet('验收标准', pkg.acceptance))
    lines.push(...bullet('已经完成（有证据）', pkg.done))
    lines.push(...bullet('未完成 / 失败与原因', pkg.remaining))
    lines.push(...bullet('下一步', pkg.nextActions))
    lines.push(...bullet('阻塞', pkg.blockers))
    lines.push(...bullet('涉及的文件', pkg.files))
    lines.push(...bullet('其它说明', pkg.notes))
  } else {
    lines.push('', '（这次交接没有留下交接包，请从当前工作目录看出该做什么，必要时向用户确认。）')
  }
  lines.push('', RESUME_FOOTER)
  return lines.join('\n')
}

export function containsResumeEvidence(rawText: unknown, resumeId: string): boolean {
  const text = typeof rawText === 'string' ? rawText : ''
  const marker = resumeMarker(resumeId)
  if (!text || marker === `[${RESUME_ID_TAG}:]`) return false
  return text.includes(marker)
}

export function hasExplicitHandoffStartReceipt(rawText: unknown, resumeId: string): boolean {
  const text = typeof rawText === 'string' ? rawText : ''
  const operationId = String(resumeId ?? '').trim()
  if (!text || !operationId || !containsResumeEvidence(text, operationId)) return false
  for (const match of text.matchAll(/^[^\r\n]*"customType"\s*:\s*"yan-handoff-started"[^\r\n]*$/gm)) {
    try {
      const entry = JSON.parse(match[0]) as {
        type?: unknown
        customType?: unknown
        data?: { operationId?: unknown; hook?: unknown }
      }
      if (
        entry.type === 'custom' &&
        entry.customType === 'yan-handoff-started' &&
        entry.data?.operationId === operationId &&
        entry.data?.hook === 'before_provider_request'
      ) {
        return true
      }
    } catch {
    }
  }
  return false
}

export function hasResumeEvidence(
  messages: { role?: string; text?: unknown; content?: unknown }[],
  resumeId: string
): boolean {
  const marker = resumeMarker(resumeId)
  if (!resumeId || marker === `[${RESUME_ID_TAG}:]`) return false
  return messages.some((message) => {
    if (message?.role !== 'user' && message?.role !== 'custom') return false
    const body =
      typeof message.text === 'string'
        ? message.text
        : typeof message.content === 'string'
          ? message.content
          : ''
    return body.includes(marker)
  })
}

export function resumePreview(text: string, limit = 160): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
