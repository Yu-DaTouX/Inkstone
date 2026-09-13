import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { shortProject } from './rail-utils'

/**
 * 左栏底部的用户块：头像 + 名字 + 设置。
 *
 * ── 用户的要求（附图）──
 * ① 原来是「砚 / 工作目录 / N 个会话」，改成**用户名 + 可自定义头像**
 * ② 预留登录功能
 * ③ 设置按钮太小（缩放不对）
 *
 * ── 三个设计决定 ──
 * · **头像可自定义**：内置图标选择 + 色相调节，不引入文件上传 ——
 *   上传要处理格式/裁剪/存储/体积，而这些在「桌面端本地模式」里
 *   收益很低（用户只是想把自己的头像和默认的区分开）。
 *   内置一组图标 + 12 档色相已经能做出几十种组合。
 * · **登录只做预留，不做假状态**。点「登录」**不会**显示一个假的已登录。
 *   它开一个说明面板：本地模式是什么意思、接入后会同步什么。
 *   本项目的约定是「界面上出现的每个值都必须真的来自某个地方」，
 *   一个假的登录态会让后面所有关于「同步」的显示都变成谎言。
 * · **名字默认取系统用户名**（见 main/settings.ts），空则显示「你」。
 *
 * 工作目录与会话数**没有丢**：目录在工具栏的文件树根部、会话数在项目分组
 * 的计数里。这里原来那份是重复信息。
 */

/** 可选的预设头像图标（都来自内置 sprite，见 src/renderer/src/icons） */
const AVATAR_ICONS = [
  'sparkle',
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

/** 色相预设。12 档，够拉开差异又不用拖滑块 */
const HUES = [0, 30, 60, 90, 140, 170, 200, 220, 260, 290, 320, 340]

export function RailUser() {
  const t = useT()
  const profile = useStore((s) => s.settings?.profile)
  const openSettings = useStore((s) => s.openSettings)
  const conn = useStore((s) => s.conn)

  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  /* 点外面关掉（与左栏其它浮层同一套做法） */
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    // 延后一帧挂，免得打开的那一下点击立刻把自己关掉
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
  /** 有自定义色时用 hsl，否则跟着主题的中性色 */
  const avatarStyle: React.CSSProperties =
    hue >= 0 ? { background: `hsl(${hue} 42% 26%)`, borderColor: `hsl(${hue} 38% 38%)` } : {}

  return (
    <div className="rail-foot" ref={popRef}>
      {/* 头像 —— 点它开自定义面板 */}
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
          <Icon name={profile.avatarValue as 'sparkle'} size={14} />
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

      {/*
       * 设置入口。
       * 用户报「太小」：原来是 .rail-icon.sm（22px 盒 + 12px 图标），
       * 跟旁边的 26px 头像不成比例。现在用标准尺寸（26px 盒 + 14px 图标）。
       */}
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

  /**
   * 名字输入是**本地缓冲 + 失焦提交**。
   * 每敲一个字就落盘会把设置文件写很多次，而且中途的空串会让
   * 左栏那个名字闪成「你」。
   */
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
        <button className="rup-x" onClick={onClose} title={t('set.close')}>
          ✕
        </button>
      </div>

      {login ? (
        /* ---- 登录说明（预留功能，不假装已接入）---- */
        <div className="rup-login-note" data-testid="rail-login-note">
          <div className="rup-note-title">{t('rail.loginTitle')}</div>
          <p className="rup-note-body">{t('rail.loginNote')}</p>
          <ul className="rup-note-list">
            <li>{t('rail.loginWill1')}</li>
            <li>{t('rail.loginWill2')}</li>
            <li>{t('rail.loginWill3')}</li>
          </ul>
          <button className="rup-btn" onClick={() => setLogin(false)} data-testid="rail-login-back">
            {t('rail.back')}
          </button>
        </div>
      ) : (
        <>
          {/* ---- 名字 ---- */}
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

          {/* ---- 头像形式 ---- */}
          <div className="rup-row">
            <span className="rup-label">{t('rail.avatar')}</span>
            <div className="rup-seg">
              <button
                className={`rup-seg-btn ${!profile?.avatarKind || profile.avatarKind === 'letter' ? 'sel' : ''}`}
                onClick={() => void patchProfile({ avatarKind: 'letter', avatarValue: '' })}
                data-testid="rail-avatar-letter"
              >
                {t('rail.letter')}
              </button>
              <button
                className={`rup-seg-btn ${profile?.avatarKind === 'icon' ? 'sel' : ''}`}
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

          {/* ---- 图标网格（选了图标才显示）---- */}
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

          {/* ---- 色相 ---- */}
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

          {/* ---- 工作目录（原来底栏那行路径放这里，不再常驻占位）---- */}
          <div className="rup-row">
            <span className="rup-label">{t('rp.fsRoot')}</span>
            <span className="rup-value" title={cwd}>
              {cwd ? shortProject(cwd) : '—'}
            </span>
          </div>

          <button
            className="rup-btn rup-login"
            onClick={() => setLogin(true)}
            data-testid="rail-login"
          >
            {t('rail.login')}
          </button>
        </>
      )}
    </div>
  )
}
