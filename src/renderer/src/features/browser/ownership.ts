import type { WorkspaceOwner } from '../workbench/types'

export interface BrowserSurfaceInputs {
  owner: WorkspaceOwner
  visible: boolean
  browserOpen: boolean
  browserOwnerKey: string | undefined
}

export function browserControlAllowed(inputs: BrowserSurfaceInputs): boolean {
  return (
    inputs.owner.active &&
    inputs.visible &&
    inputs.browserOpen &&
    inputs.browserOwnerKey === inputs.owner.key
  )
}

export class BrowserSurfaceClaim {
  private key: string | null = null

  claim(key: string): boolean {
    if (this.key === null || this.key === key) {
      this.key = key
      return true
    }
    return false
  }

  release(key: string): boolean {
    if (this.key !== key) return false
    this.key = null
    return true
  }

  current(): string | null {
    return this.key
  }
}
