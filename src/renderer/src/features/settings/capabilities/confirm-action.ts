export interface ConfirmActionOutcome {
  ok: boolean
  error?: string
}

export function confirmActionError(cause: unknown): string | undefined {
  const message =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
  if (typeof message !== 'string') return undefined
  const trimmed = message.trim()
  return trimmed === '' ? undefined : trimmed
}

export async function runConfirmAction(action: () => Promise<void> | void): Promise<ConfirmActionOutcome> {
  try {
    await action()
    return { ok: true }
  } catch (cause) {
    const error = confirmActionError(cause)
    return error === undefined ? { ok: false } : { ok: false, error }
  }
}
