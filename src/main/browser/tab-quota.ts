import { pick } from '../../shared/ui-lang'

export const MAX_TABS_PER_SESSION = 12
export const POPUP_NOTICE_INTERVAL_MS = 5000

export class TabQuotaError extends Error {
  constructor() {
    super(pick(`该会话的浏览器标签已达上限（${MAX_TABS_PER_SESSION} 个），请先关闭不用的标签`, `This session has reached the browser tab limit (${MAX_TABS_PER_SESSION}); close unused tabs first`))
    this.name = 'TabQuotaError'
  }
}

export class SessionClosedError extends Error {
  constructor() {
    super(pick('该会话的浏览器已关闭', 'The browser for this session was closed'))
    this.name = 'SessionClosedError'
  }
}
