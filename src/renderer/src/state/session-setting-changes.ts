const pending = new Map<string, Set<Promise<void>>>()

export function trackSessionSetting<T>(runId: string | null | undefined, task: Promise<T>): Promise<T> {
  if (!runId) return task
  const changes = pending.get(runId) ?? new Set<Promise<void>>()
  pending.set(runId, changes)
  const settled = task.then(() => undefined, () => undefined)
  changes.add(settled)
  void settled.then(() => {
    changes.delete(settled)
    if (!changes.size && pending.get(runId) === changes) pending.delete(runId)
  })
  return task
}

export function sessionSettingsPending(runId: string | null | undefined): boolean {
  return !!runId && !!pending.get(runId)?.size
}

export async function sessionSettingsSettled(runId: string | null | undefined): Promise<void> {
  for (let changes = runId ? pending.get(runId) : undefined; changes?.size; changes = pending.get(runId!)) {
    await Promise.all([...changes])
  }
}
