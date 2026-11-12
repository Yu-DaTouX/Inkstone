export const SIDE_QUESTION_BLOCK = 'Side question: tools are disabled here and nothing was executed. Answer only from the conversation above; if something cannot be known from it, say what is missing.'

export function sideQuestionActive(env = process.env) {
  return env.YAN_SIDE_QUESTION === '1'
}

export default function sideQuestion(pi, env = process.env) {
  if (!sideQuestionActive(env)) return
  pi.on('tool_call', () => ({ block: true, reason: SIDE_QUESTION_BLOCK }))
}
