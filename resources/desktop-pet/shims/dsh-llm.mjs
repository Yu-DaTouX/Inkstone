export function createUserMessage(input) {
  return { role: 'user', content: input.content, source: input.source }
}

export function createAssistantMessage(input) {
  return { role: 'assistant', content: input.content, source: input.source }
}

export function ReasoningEffortId(id) {
  return id
}

export class BlockAssembler {
  constructor() {
    this.parts = []
    this.finish = undefined
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return
    if (chunk.type === 'text' && typeof chunk.text === 'string') this.parts.push(chunk.text)
    else if (chunk.type === 'finish') this.finish = chunk.finish
  }

  blocks() {
    const text = this.parts.join('')
    return text ? [{ type: 'text', text }] : []
  }
}
