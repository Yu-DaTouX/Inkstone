import { appendReminder } from './request-reminder.js'

export const FINISH_IDLE_STEPS = 4
export const FINISH_MAX_REMINDERS = 2

export const FINISH_REMINDER = `<system-reminder>The project's tests passed after your last code change, and the last ${FINISH_IDLE_STEPS} steps changed no code. If every requested item is done, give the final answer now. Continue only to fix a concrete defect you have observed; report remaining doubts in the final answer instead of re-investigating them. Do not mention this reminder.</system-reminder>`

const CODE_CHANGE_TOOLS = new Set(['edit', 'write'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])
const TEST_COMMAND = /(?:^|[\s;&|(/])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:(?:npx|bunx|pnpm\s+exec|yarn)\s+)?(?:mocha|jest|vitest)\b|(?:python3?\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b|(?:mvnw?|gradlew?)\b[^;&|\n]*\btest\b|make\s+test\b|node\s+--test\b)/i

export function isTestCommand(command) {
  return TEST_COMMAND.test(String(command ?? ''))
}

function exitedCleanly(event) {
  const code = event?.details?.exit_code ?? event?.details?.exitCode
  if (typeof code === 'number') return code === 0 && event?.isError !== true
  return event?.isError === false
}

export function createFinishTracker() {
  let passed = false
  let passedThisTurn = false
  let idle = 0
  let reminders = 0
  return {
    reset() {
      passed = false
      passedThisTurn = false
      idle = 0
      reminders = 0
    },
    toolCall(toolName) {
      if (!CODE_CHANGE_TOOLS.has(toolName)) return
      passed = false
      passedThisTurn = false
      idle = 0
    },
    toolResult(event) {
      if (!SHELL_TOOLS.has(String(event?.toolName ?? ''))) return
      if (!isTestCommand(event?.input?.command)) return
      passed = exitedCleanly(event)
      passedThisTurn = passed
      idle = 0
    },
    request() {
      if (!passed) return false
      if (passedThisTurn) passedThisTurn = false
      else idle += 1
      return reminders < FINISH_MAX_REMINDERS && idle >= FINISH_IDLE_STEPS * (reminders + 1)
    },
    reminded() {
      reminders += 1
    }
  }
}

export function registerFinishReminder(pi) {
  const tracker = createFinishTracker()
  pi.on('message_end', (event) => {
    if (String(event?.message?.role ?? '') === 'user') tracker.reset()
  })
  pi.on('tool_call', (event) => {
    tracker.toolCall(String(event?.toolName ?? ''))
    return undefined
  })
  pi.on('tool_result', (event) => {
    tracker.toolResult(event)
    return undefined
  })
  pi.on('before_provider_request', (event) => {
    if (!tracker.request()) return undefined
    const next = appendReminder(event?.payload, FINISH_REMINDER)
    if (!next) return undefined
    tracker.reminded()
    return next
  })
}
