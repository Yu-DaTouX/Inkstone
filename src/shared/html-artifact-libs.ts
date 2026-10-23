export const ARTIFACT_LIB_NAMES = ['three'] as const

export type ArtifactLibName = (typeof ARTIFACT_LIB_NAMES)[number]

const LIB_TAG = /<script\b[^>]*?\bdata-yan-lib\s*=\s*(["']?)([a-z0-9-]+)\1[^>]*>\s*<\/script\s*>/gi

function isArtifactLib(name: string): name is ArtifactLibName {
  return (ARTIFACT_LIB_NAMES as readonly string[]).includes(name)
}

export function usesArtifactLibs(html: string): boolean {
  LIB_TAG.lastIndex = 0
  return LIB_TAG.test(html)
}

export function inlineArtifactLibs(html: string, readLib: (name: ArtifactLibName) => string | null): string {
  if (!/data-yan-lib/i.test(html)) return html
  return html.replace(LIB_TAG, (tag: string, _quote: string, name: string) => {
    const lowered = name.toLowerCase()
    const code = isArtifactLib(lowered) ? readLib(lowered) : null
    if (code === null) return tag
    return `<script data-yan-lib-inline="${lowered}">${code.replace(/<\/script/gi, '<\\/script')}</script>`
  })
}
