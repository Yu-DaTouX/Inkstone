export type SpaceView = 'overview' | 'library'

export const SPACE_VIEW_KEY = 'yan.space-view'

export const SPACE_VIEWS: readonly SpaceView[] = ['overview', 'library']

function isSpaceView(value: unknown): value is SpaceView {
  return typeof value === 'string' && (SPACE_VIEWS as readonly string[]).includes(value)
}

export function readSpaceView(): SpaceView {
  if (typeof localStorage === 'undefined') return 'overview'
  try {
    const raw = localStorage.getItem(SPACE_VIEW_KEY)
    return isSpaceView(raw) ? raw : 'overview'
  } catch {
    return 'overview'
  }
}

export function writeSpaceView(view: SpaceView): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SPACE_VIEW_KEY, view)
  } catch {
  }
}
