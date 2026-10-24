import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Trash2, UserPlus } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import type { Account } from '../../shared/api.ts'
import { accountKindLabel, accountKindTone, accountStatus } from './labels.ts'
import { SkinHead } from './SkinHead.tsx'

const SWIPE_RATIO = 0.18
const SWIPE_VELOCITY = 0.45
const WHEEL_THRESHOLD = 28
const WHEEL_COOLDOWN_MS = 320

interface Props {
  accounts: Account[]
  selectedId: string | null
  onSelect(id: string): void
  onAdd(): void
  onRemove(id: string): void
}

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  startAt: number
  horizontal: boolean | null
}

export function AccountCarousel({ accounts, selectedId, onSelect, onAdd, onRemove }: Props): ReactElement {
  const index = Math.max(0, accounts.findIndex((account) => account.id === selectedId))
  const current = accounts[index]
  const viewport = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const wheel = useRef({ sum: 0, lockedUntil: 0 })
  const [drag, setDrag] = useState<number | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const go = useCallback(
    (next: number): void => {
      const target = accounts[Math.min(Math.max(next, 0), accounts.length - 1)]
      if (target && target.id !== current?.id) onSelect(target.id)
    },
    [accounts, current?.id, onSelect]
  )

  useEffect(() => setConfirmRemove(false), [current?.id])

  useEffect(() => {
    if (!confirmRemove) return
    const timer = setTimeout(() => setConfirmRemove(false), 3000)
    return () => clearTimeout(timer)
  }, [confirmRemove])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (delta === 0) return
      event.preventDefault()
      const now = performance.now()
      if (now < wheel.current.lockedUntil) return
      wheel.current.sum += delta
      if (Math.abs(wheel.current.sum) < WHEEL_THRESHOLD) return
      const step = wheel.current.sum > 0 ? 1 : -1
      wheel.current = { sum: 0, lockedUntil: now + WHEEL_COOLDOWN_MS }
      go(index + step)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [go, index])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || accounts.length < 2) return
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startAt: performance.now(), horizontal: null }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    if (active.horizontal === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      active.horizontal = Math.abs(dx) > Math.abs(dy)
      if (!active.horizontal) {
        gesture.current = null
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const atEdge = (index === 0 && dx > 0) || (index === accounts.length - 1 && dx < 0)
    setDrag(atEdge ? dx / 3 : dx)
  }

  const endGesture = (event: PointerEvent<HTMLDivElement>): void => {
    const active = gesture.current
    gesture.current = null
    if (!active || active.pointerId !== event.pointerId || !active.horizontal) {
      setDrag(null)
      return
    }
    const dx = event.clientX - active.startX
    const width = viewport.current?.clientWidth ?? 1
    const velocity = Math.abs(dx) / Math.max(performance.now() - active.startAt, 1)
    setDrag(null)
    if (Math.abs(dx) > width * SWIPE_RATIO || velocity > SWIPE_VELOCITY) go(dx < 0 ? index + 1 : index - 1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') go(index - 1)
    else if (event.key === 'ArrowRight') go(index + 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(accounts.length - 1)
    else return
    event.preventDefault()
  }

  return (
    <div className="carousel">
      <div className="carousel__stage">
        <IconButton aria-label="上一个账号" size="sm" className="carousel__arrow" isDisabled={index === 0} onPress={() => go(index - 1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <div
          ref={viewport}
          className="carousel__viewport"
          tabIndex={0}
          role="group"
          aria-roledescription="账号轮播"
          aria-label={current ? `当前账号 ${current.name}，${index + 1} / ${accounts.length}，左右方向键切换` : '账号'}
          data-dragging={drag !== null ? '1' : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <div className="carousel__track" style={{ transform: `translateX(calc(${-index * 100}% + ${drag ?? 0}px))` }}>
            {accounts.map((account, position) => (
              <div key={account.id} className="carousel__slide" aria-hidden={position !== index}>
                <SkinHead account={account} size={88} />
                <div className="carousel__name">{account.name}</div>
                <div className="carousel__meta">
                  <Badge tone={accountKindTone(account)}>{accountKindLabel(account)}</Badge>
                  <span>{accountStatus(account)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <IconButton aria-label="下一个账号" size="sm" className="carousel__arrow" isDisabled={index >= accounts.length - 1} onPress={() => go(index + 1)}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
      <div className="carousel__dots" aria-hidden="true">
        {accounts.map((account, position) => (
          <span key={account.id} className="carousel__dot" data-current={position === index ? '1' : undefined} />
        ))}
      </div>
      <div className="carousel__actions">
        <Button variant="ghost" size="sm" icon={<UserPlus size={14} />} onPress={onAdd}>
          添加账号
        </Button>
        {current ? (
          <Button
            variant={confirmRemove ? 'danger' : 'ghost'}
            size="sm"
            icon={<Trash2 size={14} />}
            aria-label={confirmRemove ? `确认移除 ${current.name}` : `移除 ${current.name}`}
            onPress={() => {
              if (!confirmRemove) setConfirmRemove(true)
              else onRemove(current.id)
            }}
          >
            {confirmRemove ? '确认移除' : '移除'}
          </Button>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite">
        {current ? `已切换到 ${current.name}（${accountKindLabel(current)}）` : ''}
      </div>
    </div>
  )
}
