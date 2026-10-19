const EXTENSION_LANGUAGE: Record<string, string> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  hpp: 'cpp',
  hh: 'cpp',
  cc: 'cpp',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  kts: 'kotlin',
  mdx: 'markdown',
  markdown: 'markdown',
  gql: 'graphql',
  cfg: 'ini',
  conf: 'ini',
  env: 'bash',
  gradle: 'kotlin',
  mk: 'makefile'
}

const FILENAME_LANGUAGE: Record<string, string> = {
  makefile: 'makefile',
  dockerfile: 'bash',
  '.gitignore': 'bash',
  '.env': 'bash',
  '.npmrc': 'ini',
  '.editorconfig': 'ini'
}

export function languageCandidates(name: string): string[] {
  const lower = name.toLowerCase()
  const out: string[] = []
  const byName = FILENAME_LANGUAGE[lower]
  if (byName) out.push(byName)
  const dot = lower.lastIndexOf('.')
  if (dot > 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1)
    const mapped = EXTENSION_LANGUAGE[ext]
    if (mapped) out.push(mapped)
    out.push(ext)
  }
  return [...new Set(out)]
}

export function pickLanguage(name: string, registered: (language: string) => boolean): string | null {
  return languageCandidates(name).find((language) => registered(language)) ?? null
}
