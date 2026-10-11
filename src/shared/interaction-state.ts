export type InteractionValues = Record<string, string>
export const INTERACTION_VALUE_LIMIT = 64 * 1024
export const INTERACTION_FILE_LIMIT = 4 * 1024 * 1024

export function validInteractionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !['__proto__', 'constructor', 'prototype'].includes(value)
}
