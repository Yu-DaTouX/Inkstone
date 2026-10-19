const MAX_PATHS_PER_SENDER = 200
const MAX_PATH_LENGTH = 4096

export class UnsavedFilesRegistry {
  private readonly bySender = new Map<number, Set<string>>()

  report(senderId: number, raw: unknown): number {
    const paths = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH)
      : []
    const unique = new Set(paths.slice(0, MAX_PATHS_PER_SENDER))
    if (unique.size === 0) this.bySender.delete(senderId)
    else this.bySender.set(senderId, unique)
    return this.count()
  }

  forget(senderId: number): void {
    this.bySender.delete(senderId)
  }

  paths(): string[] {
    const all = new Set<string>()
    for (const set of this.bySender.values()) for (const path of set) all.add(path)
    return [...all]
  }

  count(): number {
    return this.paths().length
  }
}

export const unsavedFiles = new UnsavedFilesRegistry()
