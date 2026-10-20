export type PreviewFormat = 'markdown' | 'csv' | 'html' | 'svg' | 'image' | 'audio' | 'video' | 'pdf'

const TEXT_FORMATS: ReadonlySet<PreviewFormat> = new Set(['markdown', 'csv', 'html', 'svg'])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'ico'])

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv'])

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg', 'oga'])

export function previewExtension(name: string): string {
  const value = String(name ?? '')
  const at = value.lastIndexOf('.')
  if (at < 0) return ''
  return value.slice(at + 1).toLowerCase()
}

export function previewFormatOf(name: string): PreviewFormat | null {
  const value = String(name ?? '')
  if (/\.html?$/i.test(value)) return 'html'
  if (/\.svg$/i.test(value)) return 'svg'
  if (/\.(tsv|csv)$/i.test(value)) return 'csv'
  if (/\.(md|mdx|markdown)$/i.test(value)) return 'markdown'
  const ext = previewExtension(value)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  return null
}

export function csvDelimiterOf(name: string): string {
  return /\.tsv$/i.test(String(name ?? '')) ? '\t' : ','
}

export function previewFormatUsesText(format: PreviewFormat | null): boolean {
  return format !== null && TEXT_FORMATS.has(format)
}

export function previewFormatIsMedia(format: PreviewFormat | null): boolean {
  return format === 'image' || format === 'audio' || format === 'video' || format === 'pdf'
}

export function previewFormatOpensAsSource(format: PreviewFormat | null): boolean {
  return format === 'html'
}
