/** Package only the selected generation, keeping the installed layout stable. */
module.exports = async function beforePack(context) {
  const { selectedPiRuntime } = await import('./lib/pi-runtime-location.mjs')
  const { join } = require('node:path')
  const { existsSync } = require('node:fs')
  const root = selectedPiRuntime(join(context.packager.projectDir, 'resources', 'pi-runtime'))
  if (!existsSync(join(root, 'dist', 'bundle', 'cli.js'))) throw new Error('Selected pi runtime is missing')
  for (const entry of context.packager.config.extraResources ?? []) {
    if (typeof entry === 'object' && ['pi-runtime/dist', 'pi-runtime/node_modules', 'pi-runtime/package.json'].includes(entry.to)) {
      const relative = entry.to.slice('pi-runtime/'.length)
      entry.from = join(root, relative)
    }
  }
}
