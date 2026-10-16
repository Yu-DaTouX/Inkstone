import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { identityForAwait, useStore } from '../../state/store'
import { Tip } from '../ui'

export function PlusMenu({ onInsert }: { onInsert: (text: string) => void }) {
  const t = useT()
  const pickImages = useStore((s) => s.pickImages)
  const pickFiles = useStore((s) => s.pickFiles)
  const setGoal = useStore((s) => s.setGoal)
  const openSettings = useStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [caps, setCaps] = useState<{ id: string; title: string; hint: string }[] | null>(null)
  const [composing, setComposing] = useState(false)
  const [goalText, setGoalText] = useState('')
  const [outcomeText, setOutcomeText] = useState('')
  const [extrasOpen, setExtrasOpen] = useState(false)
  const [deliverableText, setDeliverableText] = useState('')
  const [scopeText, setScopeText] = useState('')
  const [constraintsText, setConstraintsText] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const goalInputRef = useRef<HTMLTextAreaElement>(null)
  const MENU_WIDTH = 340

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const el = buttonRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8))
      setAnchor({ left, bottom: Math.max(8, window.innerHeight - r.top + 6) })
    }
    menuRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open || caps) return
    let alive = true
    void (async () => {
      try {
        const snap = await window.yan.capabilities.snapshot()
        if (!alive) return
        setCaps([
          ...snap.skills.map((s) => ({ id: `skill:${s.id}`, title: s.title, hint: s.description })),
          ...snap.servers.map((s) => ({
            id: `mcp:${s.id}`,
            title: s.title,
            hint: s.enabled ? s.transport : `${s.transport} · ${t('cap.disabled')}`
          }))
        ])
      } catch {
        if (alive) setCaps([])
      }
    })()
    return () => {
      alive = false
    }
  }, [open, caps, t])

  const close = (): void => {
    setOpen(false)
    setComposing(false)
    buttonRef.current?.focus()
  }

  useEffect(() => {
    if (open && composing) goalInputRef.current?.focus()
  }, [open, composing])

  const startGoal = async (): Promise<void> => {
    const goal = goalText.trim()
    const outcome = outcomeText.trim()
    if (!goal || !outcome) return
    const deliverable = deliverableText.trim()
    const scope = scopeText.trim()
    const constraints = constraintsText.trim()
    const before = identityForAwait(useStore.getState())
    const res = await setGoal({
      goal,
      outcome,
      ...(deliverable ? { deliverable } : {}),
      ...(scope ? { scope } : {}),
      ...(constraints ? { constraints } : {})
    })
    if (!res.ok) return
    if (identityForAwait(useStore.getState()) !== before) return
    close()
    const extra = [
      deliverable ? t('plus.goalSeedDeliverable', { value: deliverable }) : '',
      scope ? t('plus.goalSeedScope', { value: scope }) : '',
      constraints ? t('plus.goalSeedConstraints', { value: constraints }) : ''
    ].filter(Boolean)
    onInsert([t('plus.goalSeed', { goal, outcome }), ...extra].join('\n'))
    setGoalText('')
    setOutcomeText('')
    setDeliverableText('')
    setScopeText('')
    setConstraintsText('')
    setExtrasOpen(false)
  }

  return (
    <div className="mode-picker" ref={rootRef}>
      <Tip label={t('composer.attach')}>
        <button
          ref={buttonRef}
          className="ctool"
          data-testid="composer-attach"
          aria-label={t('composer.attach')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              close()
            }
          }}
        >
          <Icon name="plus" size={12} />
        </button>
      </Tip>

      {open ? (
        <div
          className="mode-menu plus-menu"
          role="menu"
          data-testid="plus-menu"
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setOpen(false)
              setComposing(false)
            }
          }}
          style={{ width: MENU_WIDTH, ...(anchor ? { left: anchor.left, bottom: anchor.bottom } : {}) }}
        >
          {composing ? (
            <div className="plus-compose" data-testid="plus-goal-compose">
              <span className="plus-group-label">{t('plus.goalTitle')}</span>
              <label className="plus-field">
                <span className="plus-field-label">{t('plus.goalField')}</span>
                <textarea
                  ref={goalInputRef}
                  className="plus-input"
                  data-testid="plus-goal-text"
                  rows={2}
                  value={goalText}
                  placeholder={t('plus.goalPlaceholder')}
                  onChange={(e) => setGoalText(e.target.value)}
                />
              </label>
              <label className="plus-field">
                <span className="plus-field-label">{t('plus.outcomeField')}</span>
                <textarea
                  className="plus-input"
                  data-testid="plus-outcome-text"
                  rows={2}
                  value={outcomeText}
                  placeholder={t('plus.outcomePlaceholder')}
                  onChange={(e) => setOutcomeText(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="plus-extras-toggle"
                data-testid="plus-goal-extras-toggle"
                aria-expanded={extrasOpen}
                onClick={() => setExtrasOpen((v) => !v)}
              >
                {t('plus.extrasToggle')}
              </button>
              {extrasOpen ? (
                <>
                  <label className="plus-field">
                    <span className="plus-field-label">{t('plus.deliverableField')}</span>
                    <textarea
                      className="plus-input"
                      data-testid="plus-deliverable-text"
                      rows={2}
                      value={deliverableText}
                      placeholder={t('plus.deliverablePlaceholder')}
                      onChange={(e) => setDeliverableText(e.target.value)}
                    />
                  </label>
                  <label className="plus-field">
                    <span className="plus-field-label">{t('plus.scopeField')}</span>
                    <textarea
                      className="plus-input"
                      data-testid="plus-scope-text"
                      rows={2}
                      value={scopeText}
                      placeholder={t('plus.scopePlaceholder')}
                      onChange={(e) => setScopeText(e.target.value)}
                    />
                  </label>
                  <label className="plus-field">
                    <span className="plus-field-label">{t('plus.constraintsField')}</span>
                    <textarea
                      className="plus-input"
                      data-testid="plus-constraints-text"
                      rows={2}
                      value={constraintsText}
                      placeholder={t('plus.constraintsPlaceholder')}
                      onChange={(e) => setConstraintsText(e.target.value)}
                    />
                  </label>
                </>
              ) : null}
              <div className="plus-actions">
                <button
                  className="plus-start"
                  data-testid="plus-goal-start"
                  disabled={!goalText.trim() || !outcomeText.trim()}
                  onClick={() => void startGoal()}
                >
                  {t('plus.goalStart')}
                </button>
                <button
                  className="plus-back"
                  data-testid="plus-goal-back"
                  onClick={() => setComposing(false)}
                >
                  {t('plus.goalBack')}
                </button>
              </div>
            </div>
          ) : (
            <>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-files"
            onClick={() => {
              close()
              void pickFiles()
            }}
          >
            <span className="mode-item-label">{t('plus.files')}</span>
            <span className="mode-item-desc">{t('plus.filesHint')}</span>
          </button>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-images"
            onClick={() => {
              close()
              void pickImages()
            }}
          >
            <span className="mode-item-label">{t('plus.images')}</span>
            <span className="mode-item-desc">{t('plus.imagesHint')}</span>
          </button>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-goal"
            onClick={() => setComposing(true)}
          >
            <span className="mode-item-label">{t('plus.goal')}</span>
            <span className="mode-item-desc">{t('plus.goalHint')}</span>
          </button>

          <div className="plus-group" data-testid="plus-capabilities">
            <span className="plus-group-label">{t('plus.capabilities')}</span>
            {caps === null ? null : caps.length === 0 ? (
              <button
                className="mode-item plus-empty"
                data-testid="plus-cap-empty"
                onClick={() => {
                  close()
                  openSettings('capabilities')
                }}
              >
                <span className="mode-item-label">{t('plus.capEmpty')}</span>
                <span className="mode-item-desc">{t('plus.capEmptyHint')}</span>
              </button>
            ) : (
              caps.map((cap) => (
                <button
                  key={cap.id}
                  className="mode-item"
                  role="menuitem"
                  data-testid={`plus-cap-${cap.id}`}
                  onClick={() => {
                    close()
                    onInsert(t('plus.useCapability', { title: cap.title }))
                  }}
                >
                  <span className="mode-item-label">{cap.title}</span>
                  <span className="mode-item-desc" title={cap.hint}>{cap.hint.split(/[。；;（(\n]/)[0].slice(0, 20)}</span>
                </button>
              ))
            )}
          </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
