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

const deferVirtuaMeasurements = {
  name: 'defer-virtua-measurements',
  transform(code: string, id: string) {
    if (!id.replaceAll('\\', '/').endsWith('/node_modules/virtua/lib/index.js')) return
    const original = '(t || (t = new (I(z(n)).ResizeObserver)(e))).observe(n);'
    if (!code.includes(original)) throw new Error('virtua measurement patch no longer matches the installed version')
    return code.replace(original, `
      if (!t) {
        const view = I(z(n));
        const pending = new Map();
        let frame = 0;
        t = new view.ResizeObserver((entries) => {
          for (const entry of entries) pending.set(entry.target, entry);
          if (!frame) frame = view.requestAnimationFrame(() => {
            frame = 0;
            const batch = [...pending.values()];
            pending.clear();
            if (batch.length) e(batch, t);
          });
        });
        const unobserve = t.unobserve.bind(t);
        const disconnect = t.disconnect.bind(t);
        t.unobserve = (target) => { pending.delete(target); unobserve(target); };
        t.disconnect = () => { view.cancelAnimationFrame(frame); frame = 0; pending.clear(); disconnect(); };
      }
      t.observe(n);
    `)
  }
}

export default defineConfig({
  main: {
    define,
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@modelcontextprotocol/sdk',
          '@modelcontextprotocol/core',
          '@modelcontextprotocol/client',
          '@modelcontextprotocol/ext-apps',
          'linkedom',
          '@mozilla/readability',
          'node-html-markdown',
          'tar',
          'electron-updater',
          'proper-lockfile',
          'ws'
        ]
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          protocol: resolve('src/main/protocol.ts'),
          sessions: resolve('src/main/sessions.ts'),
          'office-worker': resolve('src/main/office/worker.ts'),
          'file-search-worker': resolve('src/main/file-search-worker.ts'),
          'usage-stats-worker': resolve('src/main/usage-stats-worker.ts'),
          'git-read-worker': resolve('src/main/git-read-worker.ts'),
          'web-content-worker': resolve('src/main/web-content-worker.ts'),
          'workflow-worker': resolve('src/main/workflows/worker.ts'),
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
          'auxwin/quick-ask': resolve('src/renderer/auxwin/quick-ask.html')
        }
      }
    },
    optimizeDeps: { exclude: ['virtua'] },
    plugins: [react(), deferVirtuaMeasurements]
  }
})
