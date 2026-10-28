import type { BrowserState } from '../../../../shared/ipc'

export type BrowserOpenBlockedReason = 'foreign-owner' | 'opening-elsewhere'

export interface BrowserOpenTarget {
  key: string
  takeover?: boolean
}

export interface BrowserOpenPorts {
  open: (url?: string) => Promise<BrowserState>
  currentOwnerKey: () => string
  resourceOwner: () => string | undefined
  claimResource: (owner: string) => string
  releaseResource: () => void
  isBrowserOpen: () => boolean
  setBrowserState: (state: BrowserState) => void
  reveal: () => void
  blocked: (reason: BrowserOpenBlockedReason) => void
  failed: (message: string) => void
}

export interface BrowserOpenInput {
  owner: string
  url?: string
  guard: boolean
  takeover?: boolean
}

export class BrowserOpener {
  private generation = 0
  private readonly pending = new Map<number, string>()
  private latest: { generation: number; key: string } | null = null

  constructor(private readonly ports: BrowserOpenPorts) {}

  async open(input: BrowserOpenInput): Promise<void> {
    const { owner, url, guard, takeover } = input
    if (guard && [...this.pending.values()].some(key => key !== owner)) {
      this.ports.blocked('opening-elsewhere')
      return
    }
    const previousOwner = this.ports.resourceOwner()
    const held = this.ports.claimResource(owner)

    if (guard && held !== owner && !takeover) {
      this.ports.blocked(this.ports.isBrowserOpen() ? 'foreign-owner' : 'opening-elsewhere')
      return
    }

    const generation = guard ? ++this.generation : 0
    if (guard) {
      this.latest = { generation, key: owner }
      this.pending.set(generation, owner)
    }

    try {
      const state = await this.ports.open(url)
      if (guard && !this.isCurrent(generation, owner)) return
      if (takeover && this.ports.currentOwnerKey() === owner && this.ports.resourceOwner() !== owner) {
        this.ports.releaseResource()
        this.ports.claimResource(owner)
      }
      this.ports.setBrowserState(state)
      if (guard && this.ports.currentOwnerKey() !== owner) return
      this.ports.reveal()
    } catch (error) {
      const claimFresh = previousOwner === undefined && !this.ports.isBrowserOpen() && this.ports.resourceOwner() === owner
      if (claimFresh && (!guard || this.isCurrent(generation, owner))) this.ports.releaseResource()
      if (!guard || this.isCurrent(generation, owner)) this.ports.failed(error instanceof Error ? error.message : String(error))
    } finally {
      if (guard) this.pending.delete(generation)
    }
  }

  private isCurrent(generation: number, key: string): boolean {
    return this.latest !== null && this.latest.generation === generation && this.latest.key === key
  }
}
