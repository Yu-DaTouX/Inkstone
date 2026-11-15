import { useStore } from '../../state/store'
import type { ComposerSubmitIdentity } from '../../state/composer-recovery'
import { INLINE_IMAGE_MAX_BYTES, readFiles } from './attachment-files'

export interface DroppedFiles {
  paths: string[]
  images: File[]
  others: File[]
}

function internalPaths(data: DataTransfer): string[] {
  const many = data.getData('application/x-yan-file-paths').trim()
  const one = data.getData('application/x-yan-file-path').trim()
  if (!many && !one) return []
  let paths = [one]
  if (many) {
    try {
      const parsed: unknown = JSON.parse(many)
      paths = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [one]
    } catch {
      paths = [one]
    }
  }
  return paths.filter((value) => value.trim().length > 0)
}

export function captureDroppedFiles(data: DataTransfer): DroppedFiles | null {
  const paths = internalPaths(data)
  if (paths.length) return { paths, images: [], others: [] }
  if (!data.types.includes('Files')) return null
  const files = [...data.files]
  if (!files.length) return null
  const inline = (file: File): boolean => file.type.startsWith('image/') && file.size <= INLINE_IMAGE_MAX_BYTES
  return {
    paths: [],
    images: files.filter(inline),
    others: files.filter((file) => !inline(file))
  }
}

export function attachDroppedFiles(dropped: DroppedFiles, identity: ComposerSubmitIdentity, onSkipped: (names: string[]) => void): void {
  const store = useStore.getState()
  if (dropped.paths.length) void store.addFileRefPaths(dropped.paths, identity)
  if (dropped.images.length) void readFiles(dropped.images, (items) => useStore.getState().addAttachments(items, identity), onSkipped)
  if (dropped.others.length) void store.addFileRefs(dropped.others, identity)
}
