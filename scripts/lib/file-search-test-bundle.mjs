import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const outDir = join(root, 'out', 'test')

export async function bundleForTest(entry, name) {
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, name)
  const stub = join(outDir, `file-search-host.stub.${name}`)
  const indexPath = join(root, 'src', 'main', 'file-search-index.ts').replace(/\\/g, '/')
  writeFileSync(
    stub,
    [
      `import { runGrepJob, runNameJob } from ${JSON.stringify(indexPath)}`,
      'export function runFileSearchJob(job) {',
      "  return job.kind === 'name' ? runNameJob(job) : runGrepJob(job)",
      '}',
      'export function disposeFileSearch() {}',
      ''
    ].join('\n')
  )
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    external: ['@ff-labs/fff-node'],
    plugins: [
      {
        name: 'stub-file-search-host',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^\.\/file-search-host$/ }, () => ({ path: stub }))
        }
      }
    ]
  })
  return import(pathToFileURL(outfile).href)
}
