import {
  FILE_TYPE_EXTENSION_ICONS,
  FILE_TYPE_ICON_TONES,
  FILE_TYPE_NAME_ICONS,
  type FileTypeIconId,
  type FileTypeTone
} from './file-type-icon-map'

export { FILE_TYPE_BRAND_ICON_IDS, FILE_TYPE_DRAWN_ICON_IDS, FILE_TYPE_ICON_IDS, FILE_TYPE_ICON_TONES, type FileTypeIconId, type FileTypeTone } from './file-type-icon-map'

export function fileBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

export function fileTypeIconId(path: string): FileTypeIconId {
  const name = fileBaseName(path).toLowerCase()
  if (!name) return 'file'
  const named = FILE_TYPE_NAME_ICONS[name]
  if (named) return named
  if (name.startsWith('.env.')) return 'dotenv'
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    const icon = FILE_TYPE_EXTENSION_ICONS[name.slice(dot + 1)]
    if (icon) return icon
  }
  return 'file'
}

export function fileTypeTone(id: FileTypeIconId): FileTypeTone {
  return FILE_TYPE_ICON_TONES[id]
}
