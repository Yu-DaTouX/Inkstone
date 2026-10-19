import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { normalizeRepositoryUrl } from './src/shared/build-info'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  version?: string
  homepage?: string
  repository?: string | { url?: string }
}
let buildHash = ''
try {
  buildHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
}
const buildInfo = {
  version: pkg.version ?? '',
  buildTime: new Date().toISOString(),
  buildHash,
  repositoryUrl: normalizeRepositoryUrl(
    typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? pkg.homepage)
  )
}
const define = { __YAN_BUILD__: JSON.stringify(buildInfo) }

export default defineConfig({
  main: {
    define,
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@modelcontextprotocol/sdk', 'tar', 'electron-updater']
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          protocol: resolve('src/main/protocol.ts'),
          sessions: resolve('src/main/sessions.ts'),
          'office-worker': resolve('src/main/office/worker.ts'),
          'file-name-search-worker': resolve('src/main/file-name-search-worker.ts'),
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
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'auxwin/quick-ask': resolve('src/renderer/auxwin/quick-ask.html'),
          'auxwin/mini': resolve('src/renderer/auxwin/mini.html'),
          'auxwin/pane': resolve('src/renderer/auxwin/pane.html')
        }
      }
    },
    plugins: [react()]
  }
})
