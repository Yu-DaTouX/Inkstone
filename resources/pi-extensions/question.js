const GUIDANCE = [
  'Interactive questions use `yan question ask`. Give at most 3 concrete options (the panel adds a free-text row); one question at a time unless several are truly independent.',
  'Ask when a materially different reading would change the result and you cannot settle it from the files, the conversation or a quick check; do not ask what you can verify yourself. When you ask, stop and wait for the answer instead of guessing it.',
  'Asking never relaxes approvals, permissions or high-risk confirmations; an explicit user instruction to ask (or not to ask) wins without widening the granted scope.'
].join('\n')

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
