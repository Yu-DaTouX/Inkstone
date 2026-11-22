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
  const gallery = previews.map(({ call, image }) => ({ src: image.data ? `data:${image.mimeType};base64,${image.data}` : image.url!, alt: t('tool.image', { tool: call.name }) }))
  return (
    <span className="ui-thumbnail-strip" data-testid="tool-image-previews" onClick={(event) => event.stopPropagation()}>
      {previews.map(({ call, index }, i) => <MessageImage key={`${call.id}:${index}`} {...gallery[i]} gallery={gallery} sourceCwd={cwd} className="ui-thumbnail-strip__image" />)}
    </span>
  )
}
