import type { YanBridge } from '../../shared/ipc'

declare global {
  interface Window {
    /** contextBridge 暴露的白名单 API，见 src/preload/index.ts */
    yan: YanBridge
  }
}

export {}
