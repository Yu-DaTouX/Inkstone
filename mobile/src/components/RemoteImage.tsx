import { pick } from '../../../src/shared/ui-lang'
import { useEffect, useState } from 'react'
import { Image, Pressable, type ImageProps } from 'react-native'
import type { RemoteClient } from '../api/client'
import { Icon } from '../icons'
import { relayImages, type ResolvedImage } from '../imageCache'
import { icon, usePalette } from '../theme'

const BLANK = { uri: '' }

export function RemoteImage({ client, source, ...rest }: Omit<ImageProps, 'source'> & { client: RemoteClient; source: { uri: string; headers: Record<string, string> } }) {
  const p = usePalette()
  const [resolved, setResolved] = useState<ResolvedImage | null>(() => relayImages.peek(source.uri) ?? null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setFailed(false)
    const hit = relayImages.peek(source.uri)
    if (hit) {
      setResolved(hit)
      return
    }
    setResolved(null)
    let alive = true
    void relayImages.load(source.uri, () => client.resolveSource(source)).then((r) => { if (alive) setResolved(r) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [client, source.uri, attempt])
  if (failed) return <Pressable
    accessibilityRole="button"
    accessibilityLabel={pick('图片加载失败，点按重试', 'Image failed to load. Tap to retry')}
    onPress={() => setAttempt((count) => count + 1)}
    style={[rest.style, { alignItems: 'center', justifyContent: 'center', backgroundColor: p.bg1, borderColor: p.borderSoft, borderWidth: 1 }]}
  ><Icon name="image" size={icon.md} color={p.fgMute} /></Pressable>
  return <Image {...rest} key={attempt} onError={rest.onError} source={resolved ?? BLANK} />
}
