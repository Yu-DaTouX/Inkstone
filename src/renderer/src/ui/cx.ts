export type ClassValue = string | false | null | undefined | 0 | readonly ClassValue[]

export function cx(...parts: ClassValue[]): string {
  const out: string[] = []
  const push = (part: ClassValue): void => {
    if (!part) return
    if (typeof part === 'string') out.push(part)
    else for (const item of part) push(item)
  }
  for (const part of parts) push(part)
  return out.join(' ')
}
