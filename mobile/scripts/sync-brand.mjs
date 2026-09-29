import { readFile, writeFile } from 'node:fs/promises'
const mark = (await readFile(new URL('../../build/prompt-stone.svg', import.meta.url), 'utf8'))
  .replace(/(<g id="stone-frame"[^>]*?)stroke="currentColor"/, '$1stroke="#ecece8"')
  .replace(/(<g id="prompt"[^>]*?)stroke="currentColor"/, '$1stroke="#93a4f4"')
  .replace('<g id="stone-frame"', '<rect width="100" height="100" rx="22" fill="#151515"/><rect x="0.5" y="0.5" width="99" height="99" rx="21.5" fill="none" stroke="#2c2c29"/><g id="stone-frame"')
await writeFile(new URL('../src/brandMark.ts', import.meta.url), `// Generated from build/prompt-stone.svg by scripts/sync-brand.mjs.\nexport const BRAND_MARK = ${JSON.stringify(mark)}\n`)
