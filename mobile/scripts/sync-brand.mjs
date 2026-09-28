import { readFile, writeFile } from 'node:fs/promises'
const mark = await readFile(new URL('../../build/yan-mark.svg', import.meta.url), 'utf8')
await writeFile(new URL('../src/brandMark.ts', import.meta.url), `// Generated from build/yan-mark.svg by scripts/sync-brand.mjs.\nexport const BRAND_MARK = ${JSON.stringify(mark)}\n`)
