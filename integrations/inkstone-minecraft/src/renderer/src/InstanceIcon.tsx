import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

const requests = new Map<string, Promise<string | null>>()

function loadIcon(folder: string, versionId: string): Promise<string | null> {
  const key = `${folder.toLowerCase()}|${versionId}`
  let request = requests.get(key)
  if (!request) {
    request = window.craft.instanceIcon(folder, versionId).catch(() => null)
    requests.set(key, request)
  }
  return request
}

export function forgetInstanceIcons(): void {
  requests.clear()
}

function hue(seed: string): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

interface Props {
  folder: string
  versionId: string
  size?: number
}

export function InstanceIcon({ folder, versionId, size = 32 }: Props): ReactElement {
  const [src, setSrc] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setSrc(undefined)
    void loadIcon(folder, versionId).then((icon) => alive && setSrc(icon))
    return () => {
      alive = false
    }
  }, [folder, versionId])

  const style = { '--icon': `${size}px`, '--hue': hue(versionId) } as CSSProperties
  if (src) return <img className="res-icon" src={src} alt="" style={style} draggable={false} />
  return (
    <span className="res-icon res-icon--generated" data-loading={src === undefined ? '1' : undefined} style={style} aria-hidden="true">
      {src === null ? Array.from(versionId.trim())[0]?.toUpperCase() : null}
    </span>
  )
}
