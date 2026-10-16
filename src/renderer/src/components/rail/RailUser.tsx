import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { shortProject } from './rail-utils'
import { Button } from '../ui'

const AVATAR_ICONS = [
  'sparkles',
  'moon',
  'sun',
  'tag',
  'shield-check',
  'layers',
  'history',
  'chat-round',
  'folder',
  'pin',
  'search'
] as const

const HUES = [0, 30, 60, 90, 140, 170, 200, 220, 260, 290, 320, 340]

export function RailUser() {
  const t = useT()
  const profile = useStore((s) => s.settings?.profile)
  const openSettings = useStore((s) => s.openSettings)
  const conn = useStore((s) => s.conn)

  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    const id = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', close)
    }
  }, [open])

  const name = (profile?.name ?? '').trim() || t('rail.you')
  const letter = [...name][0] ?? '?'
  const hue = profile?.avatarHue ?? -1
  const usingIcon = profile?.avatarKind === 'icon'
  const avatarStyle: React.CSSProperties =
    hue >= 0 ? { background: `hsl(${hue} 42% 26%)`, borderColor: `hsl(${hue} 38% 38%)` } : {}

  return (
    <div className="rail-foot" ref={popRef}>
      <button
        className={`rail-avatar ${conn === 'ready' ? 'ok' : 'warn'}`}
        style={avatarStyle}
        title={t('rail.customize')}
        onClick={() => setOpen((v) => !v)}
        data-testid="rail-avatar"
        data-kind={profile?.avatarKind ?? 'letter'}
        aria-expanded={open}
      >
        {usingIcon && profile?.avatarValue ? (
          <Icon name={profile.avatarValue as 'sparkles'} size={14} />
        ) : (
          <span className="rail-avatar-letter">{letter}</span>
        )}
      </button>

      <span className="rail-user">
        <span className="rail-user-name" title={name} data-testid="rail-user-name">
          {name}
        </span>
        <span className="rail-user-sub">
          {profile?.signedIn ? t('rail.signedIn') : t('rail.localMode')}
        </span>
      </span>

      <button
        className="rail-icon"
        title={t('set.title')}
        onClick={() => openSettings()}
        data-testid="rail-settings"
      >
        <Icon name="settings" size={14} />
      </button>

      {open ? <ProfilePop onClose={() => setOpen(false)} /> : null}
    </div>
  )
}



function ProfilePop({ onClose }: { onClose: () => void }) {
  const t = useT()
  const profile = useStore((s) => s.settings?.profile)
  const patchProfile = useStore((s) => s.patchProfile)
  const cwd = useStore((s) => s.settings?.cwd)
  const [login, setLogin] = useState(false)

  const [draft, setDraft] = useState(profile?.name ?? '')
  useEffect(() => setDraft(profile?.name ?? ''), [profile?.name])

  const commitName = (): void => {
    if (draft !== (profile?.name ?? '')) void patchProfile({ name: draft })
  }

  return (
    <div className="rail-user-pop" data-testid="rail-user-pop">
      <div className="rup-head">
        <span>{t('rail.profile')}</span>
        <span className="spacer" />
        <button className="rup-x" onClick={onClose} title={t('set.close')} aria-label={t('set.close')}>
          <Icon name="close" size={12} />
        </button>
      </div>

      {login ? (
        <div className="rup-login-note" data-testid="rail-login-note">
          <div className="rup-note-title">{t('rail.loginTitle')}</div>
          <p className="rup-note-body">{t('rail.loginNote')}</p>
          <ul className="rup-note-list">
            <li>{t('rail.loginWill1')}</li>
            <li>{t('rail.loginWill2')}</li>
            <li>{t('rail.loginWill3')}</li>
          </ul>
          <Button block className="rup-action" onClick={() => setLogin(false)} data-testid="rail-login-back">
            {t('rail.back')}
          </Button>
        </div>
      ) : (
        <>
          <label className="rup-row">
            <span className="rup-label">{t('rail.name')}</span>
            <input
              className="rup-input"
              value={draft}
              maxLength={32}
              placeholder={t('rail.you')}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitName()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              data-testid="rail-name-input"
            />
          </label>

          <div className="rup-row">
            <span className="rup-label">{t('rail.avatar')}</span>
            <div className="seg sm" role="group" aria-label={t('rail.avatar')}>
              <button
                className={`seg-btn ${!profile?.avatarKind || profile.avatarKind === 'letter' ? 'sel' : ''}`}
                aria-pressed={!profile?.avatarKind || profile.avatarKind === 'letter'}
                onClick={() => void patchProfile({ avatarKind: 'letter', avatarValue: '' })}
                data-testid="rail-avatar-letter"
              >
                {t('rail.letter')}
              </button>
              <button
                className={`seg-btn ${profile?.avatarKind === 'icon' ? 'sel' : ''}`}
                aria-pressed={profile?.avatarKind === 'icon'}
                onClick={() =>
                  void patchProfile({
                    avatarKind: 'icon',
                    avatarValue: profile?.avatarValue || AVATAR_ICONS[0]
                  })
                }
                data-testid="rail-avatar-icon"
              >
                {t('rail.icon')}
              </button>
            </div>
          </div>

          {profile?.avatarKind === 'icon' ? (
            <div className="rup-icons" data-testid="rail-avatar-icons">
              {AVATAR_ICONS.map((n) => (
                <button
                  key={n}
                  className={`rup-icon ${profile.avatarValue === n ? 'sel' : ''}`}
                  title={n}
                  onClick={() => void patchProfile({ avatarValue: n })}
                >
                  <Icon name={n} size={14} />
                </button>
              ))}
            </div>
          ) : null}

          <div className="rup-row">
            <span className="rup-label">{t('rail.color')}</span>
            <div className="rup-hues" data-testid="rail-avatar-hues">
              <button
                className={`rup-hue none ${(profile?.avatarHue ?? -1) < 0 ? 'sel' : ''}`}
                title={t('rail.colorDefault')}
                onClick={() => void patchProfile({ avatarHue: -1 })}
              />
              {HUES.map((h) => (
                <button
                  key={h}
                  className={`rup-hue ${profile?.avatarHue === h ? 'sel' : ''}`}
                  style={{ background: `hsl(${h} 42% 30%)` }}
                  title={String(h)}
                  onClick={() => void patchProfile({ avatarHue: h })}
                />
              ))}
            </div>
          </div>

          <div className="rup-row">
            <span className="rup-label">{t('rp.fsRoot')}</span>
            <span className="rup-value" title={cwd}>
              {cwd ? shortProject(cwd) : '—'}
            </span>
          </div>

          <Button block className="rup-action rup-login" onClick={() => setLogin(true)} data-testid="rail-login">
            {t('rail.login')}
          </Button>
        </>
      )}
    </div>
  )
}
