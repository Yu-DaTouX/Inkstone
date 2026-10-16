export type QuestionFrequency = 'sparse' | 'balanced' | 'eager'

export const QUESTION_FREQUENCIES: readonly QuestionFrequency[] = ['sparse', 'balanced', 'eager']

export const DEFAULT_QUESTION_FREQUENCY: QuestionFrequency = 'balanced'

export function normalizeQuestionFrequency(value: unknown): QuestionFrequency {
  return QUESTION_FREQUENCIES.includes(value as QuestionFrequency)
    ? (value as QuestionFrequency)
    : DEFAULT_QUESTION_FREQUENCY
}

export const SESSION_QUESTION_FREQUENCIES = ['inherit', ...QUESTION_FREQUENCIES] as const

export type SessionQuestionFrequency = (typeof SESSION_QUESTION_FREQUENCIES)[number]

export const DEFAULT_SESSION_QUESTION_FREQUENCY: SessionQuestionFrequency = 'inherit'

export function normalizeSessionQuestionFrequency(value: unknown): SessionQuestionFrequency {
  return SESSION_QUESTION_FREQUENCIES.includes(value as SessionQuestionFrequency)
    ? (value as SessionQuestionFrequency)
    : DEFAULT_SESSION_QUESTION_FREQUENCY
}

export function isExplicitSessionQuestionFrequency(value: unknown): value is QuestionFrequency {
  return QUESTION_FREQUENCIES.includes(value as QuestionFrequency)
}

export function resolveQuestionFrequency(sessionValue: unknown, globalValue: unknown): QuestionFrequency {
  const preference = normalizeSessionQuestionFrequency(sessionValue)
  return preference === 'inherit' ? normalizeQuestionFrequency(globalValue) : preference
}
