import { useEffect, useState } from 'react'
import { Image, type ImageProps } from 'react-native'
import type { RemoteClient } from '../api/client'

export function RemoteImage({ client, source, ...rest }: Omit<ImageProps, 'source'> & { client: RemoteClient; source: { uri: string; headers: Record<string, string> } }) {
  const relayed = !!client.connection.relay
  const [resolved, setResolved] = useState<{ uri: string; headers?: Record<string, string> } | null>(relayed ? null : source)
  useEffect(() => {
    if (!relayed) {
      setResolved(source)
      return
    }
    let alive = true
    void client.resolveSource(source).then((r) => { if (alive) setResolved(r) }).catch(() => undefined)
    return () => { alive = false }
  }, [client, relayed, source.uri])
  return resolved ? <Image {...rest} source={resolved} /> : <Image {...rest} source={{ uri: '' }} />
}
