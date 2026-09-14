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
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        /*
         * 输出 **CJS**（.cjs）：主窗口开了 `sandbox: true`，
         * 而 sandboxed preload **不支持 ESM**（实测：输出 .mjs 时 preload
         * 整个加载失败，`window.yan` 直接是 undefined，界面空白）。
         * 改成 CJS 后 sandboxed preload 能正常加载。
         */
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
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
