export interface BrowserVisibilityInput {
  browserOpen: boolean
  rightPanelOpen: boolean
  activeBrowserSurface: boolean
  overlayBlockers: number
}

export function shouldShowBrowser(input: BrowserVisibilityInput): boolean {
  return input.browserOpen && input.rightPanelOpen && input.activeBrowserSurface && input.overlayBlockers === 0
}

export class OverlayBlockers {
  private readonly counts = new Map<string, number>()

  acquire(token: string): void {
    this.counts.set(token, (this.counts.get(token) ?? 0) + 1)
  }

  release(token: string): void {
    const current = this.counts.get(token)
    if (current === undefined) return
    if (current <= 1) this.counts.delete(token)
    else this.counts.set(token, current - 1)
  }

  has(token: string): boolean {
    return this.counts.has(token)
  }

  get size(): number {
    return this.counts.size
  }

  clear(): void {
    this.counts.clear()
  }
}
