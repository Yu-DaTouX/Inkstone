module.exports = async function beforePack(context) {
  const { selectedPiRuntime } = await import('./lib/pi-runtime-location.mjs')
  const { join } = require('node:path')
  const { existsSync } = require('node:fs')
  const root = selectedPiRuntime(join(context.packager.projectDir, 'resources', 'pi-runtime'))
  if (!existsSync(join(root, 'dist', 'bundle', 'cli.js'))) throw new Error('Selected pi runtime is missing')
  const searchTools = join(context.packager.projectDir, 'resources', 'search-tools')
  if (context.electronPlatformName === 'win32' && !['rg.exe', 'fd.exe'].every((file) => existsSync(join(searchTools, file)))) {
    throw new Error('Bundled rg/fd are missing; run npm run vendor:search-tools')
  }
  for (const entry of context.packager.config.extraResources ?? []) {
    if (typeof entry === 'object' && ['pi-runtime/dist', 'pi-runtime/node_modules', 'pi-runtime/package.json'].includes(entry.to)) {
      const relative = entry.to.slice('pi-runtime/'.length)
      entry.from = join(root, relative)
    }
  }
}
