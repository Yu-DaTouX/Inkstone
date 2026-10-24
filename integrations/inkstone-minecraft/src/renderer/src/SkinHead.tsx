import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import type { Account, SkinInfo } from '../../shared/api.ts'

const requests = new Map<string, Promise<SkinInfo>>()

function loadSkin(accountId: string): Promise<SkinInfo> {
  let request = requests.get(accountId)
  if (!request) {
    request = window.craft.skin(accountId).catch(() => ({ dataUrl: null, slim: false }))
    requests.set(accountId, request)
  }
  return request
}

const SKIN_TONES = ['#f1c9a5', '#e3b088', '#c98f66', '#a06e48', '#74503a']
const HAIR_TONES = ['#2b1d14', '#4a3121', '#7a4e2c', '#b5813e', '#d9b26a', '#262626', '#7b7b7b', '#8a3b2a']
const EYE_TONES = ['#3b5bdb', '#2f9e44', '#5c3d2e', '#495057', '#7048e8', '#1c7ed6']

function seedBytes(uuid: string): number[] {
  const hex = uuid.replace(/[^0-9a-f]/gi, '').padEnd(32, '0')
  return Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16))
}

function drawFallbackFace(ctx: CanvasRenderingContext2D, uuid: string): void {
  const seed = seedBytes(uuid)
  const skin = SKIN_TONES[seed[0] % SKIN_TONES.length]
  const hair = HAIR_TONES[seed[1] % HAIR_TONES.length]
  const eye = EYE_TONES[seed[2] % EYE_TONES.length]
  ctx.clearRect(0, 0, 8, 8)
  ctx.fillStyle = skin
  ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = hair
  ctx.fillRect(0, 0, 8, 2)
  const fringe = seed[3] % 3
  if (fringe > 0) ctx.fillRect(0, 2, 1, fringe + 1)
  if (fringe > 0) ctx.fillRect(7, 2, 1, fringe + 1)
  if (fringe === 2) ctx.fillRect(1, 2, 2, 1)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(1, 4, 1, 1)
  ctx.fillRect(6, 4, 1, 1)
  ctx.fillStyle = eye
  ctx.fillRect(2, 4, 1, 1)
  ctx.fillRect(5, 4, 1, 1)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)'
  ctx.fillRect(3, 5, 2, 1)
  ctx.fillRect(2, 6, 4, 1)
}

interface Props {
  account: Account
  size: number
}

export function SkinHead({ account, size }: Props): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    let alive = true
    ctx.imageSmoothingEnabled = false
    drawFallbackFace(ctx, account.uuid)
    void loadSkin(account.id).then((skin) => {
      if (!alive || !skin.dataUrl) return
      const image = new Image()
      image.onload = () => {
        if (!alive) return
        ctx.clearRect(0, 0, 8, 8)
        ctx.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8)
        ctx.drawImage(image, 40, 8, 8, 8, 0, 0, 8, 8)
      }
      image.src = skin.dataUrl
    })
    return () => {
      alive = false
    }
  }, [account.id, account.uuid])

  return <canvas ref={canvas} width={8} height={8} className="skin-head" style={{ '--head': `${size}px` } as CSSProperties} aria-hidden="true" />
}
