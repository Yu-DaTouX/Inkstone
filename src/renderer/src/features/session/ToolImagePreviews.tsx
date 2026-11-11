import { createContext, useMemo, type JSX } from 'react'
import type { UIToolCall } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { MessageImage } from './Image'
import { collectToolImagePreviews } from './tool-image-previews'
import '../../ui/ThumbnailStrip.css'

export const ToolImagePreviewScope = createContext(true)

export function ToolImagePreviews({ calls, limit = 3 }: { calls: readonly UIToolCall[]; limit?: number }): JSX.Element | null {
  const t = useT()
  const cwd = useStore((s) => s.session?.cwd)
  const previews = useMemo(() => collectToolImagePreviews(calls, limit), [calls, limit])
  if (!previews.length) return null
  return (
    <span className="ui-thumbnail-strip" data-testid="tool-image-previews" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLImageElement) {
        event.preventDefault()
        event.stopPropagation()
        event.target.click()
      }
    }}>
      {previews.map(({ call, image, index }) => <MessageImage key={`${call.id}:${index}`} src={image.data ? `data:${image.mimeType};base64,${image.data}` : image.url!} alt={t('tool.image', { tool: call.name })} sourceCwd={cwd} className="ui-thumbnail-strip__image" />)}
    </span>
  )
}
