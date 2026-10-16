import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

function settingsFile() {
  return join(dataDir(), 'desktop.json')
}

function workModeFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'work-mode', `${safe}.json`)
}

const WORK_MODES = ['standard', 'clarify', 'autonomous']

export const QUESTION_FREQUENCIES = ['sparse', 'balanced', 'eager']
export const DEFAULT_QUESTION_FREQUENCY = 'balanced'

export const SESSION_QUESTION_FREQUENCIES = ['inherit', ...QUESTION_FREQUENCIES]
export const DEFAULT_SESSION_QUESTION_FREQUENCY = 'inherit'

export function normalizeQuestionFrequency(value) {
  return QUESTION_FREQUENCIES.includes(value) ? value : DEFAULT_QUESTION_FREQUENCY
}

export function normalizeSessionQuestionFrequency(value) {
  return SESSION_QUESTION_FREQUENCIES.includes(value) ? value : DEFAULT_SESSION_QUESTION_FREQUENCY
}

export function resolveQuestionFrequency(sessionValue, globalValue) {
  const preference = normalizeSessionQuestionFrequency(sessionValue)
  return preference === 'inherit' ? normalizeQuestionFrequency(globalValue) : preference
}

function noteModeDiagnostic(hook, mode, frequency) {
  const log = process.env.YAN_QUESTION_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({
        at: new Date().toISOString(),
        hook,
        mode,
        frequency: frequency ?? null,
        sessionId: process.env.YAN_SESSION_ID ?? null,
        file: workModeFile()
      }) + '\n',
      'utf8'
    )
  } catch {
  }
}

function normalizeOwnerPath(value) {
  return typeof value === 'string' ? value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '') : undefined
}

function ownerPathEquals(a, b) {
  const left = normalizeOwnerPath(a)
  const right = normalizeOwnerPath(b)
  if (!left || !right) return false
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function snapshotOwnedBySession(record, ctx) {
  const snapId = typeof record?.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined
  const snapFile = typeof record?.sessionFile === 'string' && record.sessionFile.trim() ? record.sessionFile : undefined
  if (!snapId && !snapFile) return true
  let manager
  try {
    manager = ctx?.sessionManager
  } catch {
    manager = undefined
  }
  const ctxId = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : undefined
  const ctxFile = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : undefined
  if (!ctxId && !ctxFile) return true
  if (snapId && ctxId && snapId === ctxId) return true
  if (snapFile && ownerPathEquals(snapFile, ctxFile)) return true
  return false
}

function readOwnedSnapshot(ctx) {
  try {
    const record = JSON.parse(readFileSync(workModeFile(), 'utf8'))
    if (!record || typeof record !== 'object') return null
    return snapshotOwnedBySession(record, ctx) ? record : null
  } catch {
    return null
  }
}

function currentWorkMode(ctx) {
  const snapshot = readOwnedSnapshot(ctx)
  if (WORK_MODES.includes(snapshot?.mode)) return snapshot.mode
  try {
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    if (WORK_MODES.includes(settings?.defaultWorkMode)) return settings.defaultWorkMode
    return settings?.autonomous === true ? 'autonomous' : 'standard'
  } catch {
    return 'standard'
  }
}

export function currentQuestionFrequency(ctx) {
  const sessionValue = readOwnedSnapshot(ctx)?.questionFrequency
  const preference = normalizeSessionQuestionFrequency(sessionValue)
  if (preference !== 'inherit') return preference
  try {
    return normalizeQuestionFrequency(JSON.parse(readFileSync(settingsFile(), 'utf8'))?.questionFrequency)
  } catch {
    return DEFAULT_QUESTION_FREQUENCY
  }
}

export function currentSessionQuestionFrequency(ctx) {
  return normalizeSessionQuestionFrequency(readOwnedSnapshot(ctx)?.questionFrequency)
}

const STANDARD_MECHANICS = [
  'Interactive questions use `yan question ask`. Give at most 3 concrete options (the panel adds a free-text row); one question at a time unless several are truly independent.'
].join('\n')

const FREQUENCY_GUIDANCE = {
  sparse: [
    'Question frequency: SPARSE. Infer a reasonable reading and keep working, stating the assumption in one line; confirm only before a key decision or a risky / hard-to-reverse action.'
  ].join('\n'),
  balanced: [
    'Question frequency: BALANCED (default). Ask when a materially different reading would change the result; do not ask what you can verify yourself.'
  ].join('\n'),
  eager: [
    'Question frequency: EAGER. When several reasonable readings exist, confirm the goal with one short question before executing; never ask every few steps, never re-ask what is already settled, and never force a question onto a simple task.'
  ].join('\n')
}

const QUESTION_BOUNDARY = [
  'This preference only tunes guidance: it never relaxes approvals, permissions, or high-risk confirmations, and an explicit user instruction to ask (or not to ask) wins over the frequency setting without widening the granted scope.'
].join('\n')

const CLARIFY_GUIDANCE = [
  'Plan mode is ON: produce a plan before doing the work.',
  '- This mode is READ-ONLY: writing tools (write / edit / task updates) are disabled, and bash only accepts `yan question ask …` — nothing else, no shell operators.',
  '- Start by reading what already exists (read / grep / find / ls) instead of asking what you could find out yourself.',
  '- Ask the ONE question whose answer most changes the plan; several truly independent questions may be grouped. Never re-ask what the user already told you.',
  '- Give at most 3 concrete options; the panel always offers one row for a typed reply, so the user can write their own answer.',
  '- For low-impact unknowns, state a one-line assumption instead of asking.',
  '- Once the goal, deliverable, scope, constraints and acceptance criteria are all settled, write the final plan as concrete steps in your reply and tell the user to switch to standard mode to carry it out.',
  '- Never claim work is finished in this mode: you cannot change anything yet.'
].join('\n')

const AUTONOMOUS_GUIDANCE = [
  'Autonomous mode is ON: diagnose and solve on your own.',
  '- Do NOT ask the user questions, and do NOT call `yan question ask`.',
  '- Find the actual cause or constraint yourself first (read the code, run the failing case, check the real state) instead of stopping at the first plausible guess.',
  '- Then pick the approach you can defend, say why in one line, and carry it through: implement, verify, and keep the evidence.',
  '- Make a sensible assumption, state it in one line, and prefer reversible choices when several options are plausible.',
  '- Turn the request into a concrete plan yourself and work through it in this turn; do not wait for the user to create a plan or to say "continue".',
  '- Claim completion only with concrete evidence; a task-list checkbox is not evidence.',
  '- If the same failure repeats without new information, stop and report what blocks you instead of retrying the same thing.'
].join('\n')

function guidanceFor(mode, frequency) {
  if (mode === 'autonomous') return AUTONOMOUS_GUIDANCE
  const clause = FREQUENCY_GUIDANCE[normalizeQuestionFrequency(frequency)]
  if (mode === 'clarify') return `${CLARIFY_GUIDANCE}\n${clause}\n${QUESTION_BOUNDARY}`
  return `${STANDARD_MECHANICS}\n${clause}\n${QUESTION_BOUNDARY}`
}

export default function question(pi) {
  pi.on('before_agent_start', (event, ctx) => {
    const mode = currentWorkMode(ctx)
    const frequency = currentQuestionFrequency(ctx)
    noteModeDiagnostic('before_agent_start', mode, frequency)
    const extra = guidanceFor(mode, frequency)
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') sections.inkstone_question = extra
    return { systemPrompt: `${base}\n\n${extra}` }
  })
}
