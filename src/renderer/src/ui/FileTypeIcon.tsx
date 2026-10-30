import { memo } from 'react'
import { cx } from './cx'
import { fileTypeIconId, fileTypeTone } from './file-type-icons'
import './FileTypeIcon.css'

const SOURCES = import.meta.glob<string>('../assets/file-icons/*.svg', { query: '?raw', import: 'default', eager: true })

const MARKUP: ReadonlyMap<string, { __html: string }> = new Map(
  Object.entries(SOURCES).map(([path, svg]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), { __html: svg }])
)

const MONO_MARKUP = new Map<string, { __html: string }>()

function monoMarkup(id: string): { __html: string } | undefined {
  const source = MARKUP.get(id)
  if (!source) return undefined
  let mono = MONO_MARKUP.get(id)
  if (!mono) {
    mono = { __html: source.__html.replace(/^(<svg\b[^>]*?)\s+style="[^"]*"/, '$1') }
    MONO_MARKUP.set(id, mono)
  }
  return mono
}

export interface FileTypeIconProps {
  name: string
  size?: 12 | 14 | 16
  className?: string
  mono?: boolean
}

export const FileTypeIcon = memo(function FileTypeIcon({ name, size = 16, className, mono = false }: FileTypeIconProps) {
  const id = fileTypeIconId(name)
  return (
    <span
      className={cx('ui-file-icon', className)}
      data-icon={id}
      data-tone={fileTypeTone(id)}
      data-size={size}
      data-mono={mono ? '' : undefined}
      aria-hidden="true"
      dangerouslySetInnerHTML={(mono ? monoMarkup(id) ?? monoMarkup('file') : MARKUP.get(id)) ?? MARKUP.get('file')}
    />
  )
})
