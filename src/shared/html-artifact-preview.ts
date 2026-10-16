export const HTML_ARTIFACT_SCHEME = 'inkstone-html'
export const HTML_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024
export const HTML_ARTIFACT_SANDBOX = 'allow-scripts'
export const HTML_INLINE_MAX_BYTES = 1024 * 1024

export type HtmlArtifactPreviewError = 'outside' | 'type' | 'size' | 'read' | 'busy'
export type HtmlArtifactPreviewResult =
  | { ok: true; url: string }
  | { ok: false; error: HtmlArtifactPreviewError }

export function isHtmlArtifact(artifact: { filename: string; mediaType?: string }): boolean {
  return /\.html?$/i.test(artifact.filename) || artifact.mediaType?.split(';', 1)[0].trim().toLowerCase() === 'text/html'
}

export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts'
].join('; ')

export function htmlArtifactToken(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${HTML_ARTIFACT_SCHEME}:` || parsed.pathname !== '/index.html' || parsed.search || parsed.username || parsed.password || parsed.port) return null
    return /^[a-f0-9]{32}$/.test(parsed.hostname) ? parsed.hostname : null
  } catch {
    return null
  }
}
