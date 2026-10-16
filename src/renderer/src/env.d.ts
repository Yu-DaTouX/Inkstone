/// <reference types="vite/client" />

import type { YanBridge } from '../../shared/ipc'

declare module '*.svg' {
  const source: string
  export default source
}

declare global {
  interface Window {
    yan: YanBridge
  }
}

export {}
