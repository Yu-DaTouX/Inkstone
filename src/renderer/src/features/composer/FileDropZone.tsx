import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Files, Folder, Image } from 'lucide-react'
import { useT } from '../../i18n'

export type FileDropKind = 'image' | 'file' | 'mixed'

interface FileDropState {
  kind: FileDropKind
  rect: { top: number; left: number; width: number; height: number }
  dropped: boolean
}

const INTERNAL_TYPES = ['application/x-yan-file-path', 'application/x-yan-file-paths']
const DROP_FADE_MS = 220

export function acceptsFileDrop(data: DataTransfer | null): data is DataTransfer {
  return !!data && (data.types.includes('Files') || INTERNAL_TYPES.some((type) => data.types.includes(type)))
}

export function fileDropKind(data: DataTransfer): FileDropKind {
  if (!data.types.includes('Files')) return 'mixed'
  const types = [...data.items].filter((item) => item.kind === 'file').map((item) => item.type)
  if (!types.length) return 'mixed'
  if (types.every((type) => type.startsWith('image/'))) return 'image'
  if (types.every((type) => type && !type.startsWith('image/'))) return 'file'
  return 'mixed'
}

function dropHost(anchor: HTMLElement): HTMLElement {
  return anchor.closest<HTMLElement>('[data-tile-key]') ?? anchor.closest<HTMLElement>('.v3-chat') ?? anchor
}

export function useFileDropZone(anchor: RefObject<HTMLElement | null>, onDrop: (data: DataTransfer) => void): FileDropState | null {
  const [state, setState] = useState<FileDropState | null>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  useEffect(() => {
    const element = anchor.current
    if (!element) return
    const host = dropHost(element)
    let fade = 0
    const show = (data: DataTransfer): void => {
      window.clearTimeout(fade)
      const box = host.getBoundingClientRect()
      const rect = { top: box.top, left: box.left, width: box.width, height: box.height }
      const kind = fileDropKind(data)
      setState((prev) => prev && !prev.dropped && prev.kind === kind && prev.rect.width === rect.width && prev.rect.height === rect.height && prev.rect.top === rect.top && prev.rect.left === rect.left
        ? prev
        : { kind, rect, dropped: false })
    }
    const hide = (): void => {
      window.clearTimeout(fade)
      setState(null)
    }
    const onEnter = (event: DragEvent): void => {
      if (acceptsFileDrop(event.dataTransfer)) show(event.dataTransfer)
    }
    const onOver = (event: DragEvent): void => {
      if (!acceptsFileDrop(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      show(event.dataTransfer)
    }
    const onLeave = (event: DragEvent): void => {
      const next = event.relatedTarget as Node | null
      if (!next || !host.contains(next)) hide()
    }
    const onHostDrop = (event: DragEvent): void => {
      if (event.defaultPrevented || !acceptsFileDrop(event.dataTransfer)) return
      event.preventDefault()
      dropRef.current(event.dataTransfer)
      setState((prev) => (prev ? { ...prev, dropped: true } : null))
      window.clearTimeout(fade)
      fade = window.setTimeout(() => setState(null), DROP_FADE_MS)
    }
    const onWindowEnd = (event: DragEvent): void => {
      if (event.type === 'drop' || !event.relatedTarget) {
        if (event.type === 'drop' && host.contains(event.target as Node | null)) return
        hide()
      }
    }
    host.addEventListener('dragenter', onEnter)
    host.addEventListener('dragover', onOver)
    host.addEventListener('dragleave', onLeave)
    host.addEventListener('drop', onHostDrop)
    window.addEventListener('dragleave', onWindowEnd)
    window.addEventListener('drop', onWindowEnd)
    window.addEventListener('dragend', hide)
    return () => {
      window.clearTimeout(fade)
      host.removeEventListener('dragenter', onEnter)
      host.removeEventListener('dragover', onOver)
      host.removeEventListener('dragleave', onLeave)
      host.removeEventListener('drop', onHostDrop)
      window.removeEventListener('dragleave', onWindowEnd)
      window.removeEventListener('drop', onWindowEnd)
      window.removeEventListener('dragend', hide)
    }
  }, [anchor])
  return state
}

export function FileDropOverlay({ state }: { state: FileDropState | null }) {
  const t = useT()
  if (!state) return null
  const label = state.kind === 'image' ? t('composer.dropImage') : state.kind === 'file' ? t('composer.dropFile') : t('composer.dropHint')
  return createPortal(
    <div
      className="file-drop"
      data-testid="file-drop-overlay"
      data-kind={state.kind}
      data-state={state.dropped ? 'drop' : 'over'}
      style={{ top: state.rect.top, left: state.rect.left, width: state.rect.width, height: state.rect.height }}
    >
      <div className="file-drop-card" role="status" aria-live="polite">
        <span className="file-drop-icons" aria-hidden>
          <span className="file-drop-icon" data-icon="image"><Image /></span>
          <span className="file-drop-icon" data-icon="file"><Files /></span>
          <span className="file-drop-icon" data-icon="folder"><Folder /></span>
        </span>
        <span className="file-drop-label">{label}</span>
      </div>
    </div>,
    document.body
  )
}
