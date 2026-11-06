import { readFile } from 'node:fs/promises'

export function viteGlobShim() {
  return {
    name: 'vite-glob-shim',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (args.path.includes('node_modules')) return undefined
        const source = await readFile(args.path, 'utf8')
        if (!source.includes('import.meta.glob')) return undefined
        const replaced = source.replace(/import\.meta\.glob(?:<[^>]*>)?\([^)]*\)/g, '({})')
        return { contents: replaced, loader: args.path.endsWith('x') ? 'tsx' : 'ts' }
      })
    }
  }
}
