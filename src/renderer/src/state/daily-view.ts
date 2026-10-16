export type DailyView = 'chat' | 'map'

export const DAILY_VIEW_KEY = 'yan.daily-view'

export function readDailyView(): DailyView {
  if (typeof localStorage === 'undefined') return 'chat'
  try {
    return localStorage.getItem(DAILY_VIEW_KEY) === 'map' ? 'map' : 'chat'
  } catch {
    return 'chat'
  }
}

export function writeDailyView(view: DailyView): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DAILY_VIEW_KEY, view)
  } catch {
  }
}
