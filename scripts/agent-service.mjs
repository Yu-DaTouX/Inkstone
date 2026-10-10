import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Build outside out/ so an independent host never overwrites a running desktop build.
const dir = await mkdtemp(join(tmpdir(), 'inkstone-service-entry-'))
const outfile = join(dir, 'service.mjs')
await build({ entryPoints: [resolve('src/adapters/service-cli.ts')], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
await import(pathToFileURL(outfile).href)
