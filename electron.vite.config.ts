import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // 额外入口：让脚本能直接 import 这些**不依赖 Electron** 的模块做单元测试
          // （scripts/probe-pi.mjs 用 protocol，scripts/test-unit.mjs 用 sessions）
          protocol: resolve('src/main/protocol.ts'),
          sessions: resolve('src/main/sessions.ts'),
          'zoom-math': resolve('src/main/zoom-math.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
