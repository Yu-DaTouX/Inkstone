const STANDARD_MECHANICS = [
  'Interactive questions use `yan question ask`. Give at most 3 concrete options (the panel adds a free-text row); one question at a time unless several are truly independent.'
].join('\n')

const BALANCED_GUIDANCE = [
  'Question frequency: BALANCED (default). Ask when a materially different reading would change the result; do not ask what you can verify yourself.'
].join('\n')

const QUESTION_BOUNDARY = [
  'This preference only tunes guidance: it never relaxes approvals, permissions, or high-risk confirmations, and an explicit user instruction to ask (or not to ask) wins over the frequency setting without widening the granted scope.'
].join('\n')

const GUIDANCE = `${STANDARD_MECHANICS}\n${BALANCED_GUIDANCE}\n${QUESTION_BOUNDARY}`

export default function question(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_question = GUIDANCE
      return
    }
    return { systemPrompt: `${base}\n\n${GUIDANCE}` }
  })
}
