import type { CraftApi } from '../../shared/api.ts'
import type { DevApi } from '../../shared/dev-api.ts'

declare global {
  interface Window {
    craft: CraftApi
    craftDev: DevApi
  }
}

export {}
