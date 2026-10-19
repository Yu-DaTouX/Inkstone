export class UnsavedRegistry {
  private readonly byEditor = new Map<string, string>()

  set(editorId: string, path: string | null): boolean {
    const before = this.signature()
    if (path) this.byEditor.set(editorId, path)
    else this.byEditor.delete(editorId)
    return this.signature() !== before
  }

  paths(): string[] {
    return [...new Set(this.byEditor.values())].sort()
  }

  private signature(): string {
    return this.paths().join('\n')
  }
}

const registry = new UnsavedRegistry()

export function reportUnsavedEditor(editorId: string, path: string | null): void {
  if (!registry.set(editorId, path)) return
  const report = typeof window === 'undefined' ? undefined : window.yan?.reportUnsavedFiles
  if (typeof report === 'function') void report(registry.paths()).catch(() => undefined)
}
