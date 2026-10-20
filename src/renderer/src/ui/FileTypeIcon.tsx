import { memo } from 'react'
import { cx } from './cx'
import { fileTypeIconId, fileTypeTone } from './file-type-icons'
import './FileTypeIcon.css'

const SOURCES = import.meta.glob<string>('../assets/file-icons/*.svg', { query: '?raw', import: 'default', eager: true })

const MARKUP: ReadonlyMap<string, { __html: string }> = new Map(
  Object.entries(SOURCES).map(([path, svg]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), { __html: svg }])
)

export interface FileTypeIconProps {
  name: string
  size?: 12 | 14 | 16
  className?: string
}

export const FileTypeIcon = memo(function FileTypeIcon({ name, size = 16, className }: FileTypeIconProps) {
  const id = fileTypeIconId(name)
  return (
    <span
      className={cx('ui-file-icon', className)}
      data-icon={id}
      data-tone={fileTypeTone(id)}
      data-size={size}
      aria-hidden="true"
      dangerouslySetInnerHTML={MARKUP.get(id) ?? MARKUP.get('file')}
    />
  )
})
