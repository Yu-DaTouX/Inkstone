import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/*
 * 构建信息（注入到代码里的常量）。
 *
 * 为什么需要它：正式版本（0.2.0）区分不了“同一版本的哪一次构建”。
 * 排查“改了代码但跑的还是旧进程”这类问题时，界面上能直接看到构建时间
 * 就是最短路径 —— 用户报过一次“修复没生效”，实际是旧实例还在跑。
 *
 * 注意：这里是**构建时**读一次，所以产物里的时间就是那次构建的时刻。
 */
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: string }
let buildHash = ''
try {
  buildHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  /* 没有 git（例如从压缩包构建）时不编造 hash，界面就是空 */
}
const buildInfo = {
  version: pkg.version ?? '',
  buildTime: new Date().toISOString(),
  buildHash
}
const define = { __YAN_BUILD__: JSON.stringify(buildInfo) }

export default defineConfig({
  main: {
    define,
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
    define,
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
    define,
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
