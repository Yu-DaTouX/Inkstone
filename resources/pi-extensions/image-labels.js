const LEGEND_EN = /\(Images are numbered in attachment order: [^\n]*\)/
const LEGEND_ZH = /（附图按添加顺序编号：[^\n]*）/

function messageText(content) {
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
}

export function labelImageContent(content) {
  if (!Array.isArray(content)) return null
  const imageCount = content.filter((part) => part?.type === 'image').length
  if (imageCount === 0) return null
  const text = messageText(content)
  const english = LEGEND_EN.test(text)
  if (imageCount < 2 && !english && !LEGEND_ZH.test(text)) return null
  let n = 0
  const labeled = []
  for (const part of content) {
    if (part?.type === 'image') {
      n += 1
      labeled.push({ type: 'text', text: english ? `img${n}:` : `图${n}：` })
    }
    labeled.push(part)
  }
  return labeled
}

export function labelImageMessages(messages) {
  if (!Array.isArray(messages)) return null
  let changed = false
  const next = messages.map((message) => {
    if (message?.role !== 'user') return message
    const content = labelImageContent(message.content)
    if (!content) return message
    changed = true
    return { ...message, content }
  })
  return changed ? next : null
}

export default function imageLabelsExtension(pi) {
  pi.on('context', (event) => {
    const messages = labelImageMessages(event?.messages)
    return messages ? { messages } : undefined
  })
}
