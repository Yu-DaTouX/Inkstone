import { useEffect, useState } from 'react'
import { Image, type ImageProps } from 'react-native'
import type { RemoteClient } from '../api/client'
import { relayImages, type ResolvedImage } from '../imageCache'

const BLANK = { uri: '' }

export function RemoteImage({ client, source, ...rest }: Omit<ImageProps, 'source'> & { client: RemoteClient; source: { uri: string; headers: Record<string, string> } }) {
  const relayed = !!client.connection.relay
  const [resolved, setResolved] = useState<ResolvedImage | null>(() => (relayed ? relayImages.peek(source.uri) ?? null : null))
  useEffect(() => {
    if (!relayed) return
    const hit = relayImages.peek(source.uri)
    if (hit) {
      setResolved(hit)
      return
    }
    let alive = true
    void relayImages.load(source.uri, () => client.resolveSource(source)).then((r) => { if (alive) setResolved(r) }).catch(() => undefined)
    return () => { alive = false }
  }, [client, relayed, source.uri])
  return <Image {...rest} source={relayed ? resolved ?? BLANK : source} />
}
