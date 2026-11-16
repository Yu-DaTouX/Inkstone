const ARRIVAL_LIMIT = 400

const firstText = new Map<string, number>()

export function noteTextArrival(id: string, before: string | undefined, after: string | undefined): void {
  if (before || !after) return
  firstText.delete(id)
  firstText.set(id, performance.now())
  if (firstText.size > ARRIVAL_LIMIT) firstText.delete(firstText.keys().next().value as string)
}

export function textArrivedWithin(id: string, ms: number): boolean {
  const at = firstText.get(id)
  return at !== undefined && performance.now() - at <= ms
}
