import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'

/**
 * 关联外部任务链接（方案 §6.4）。
 *
 * ── 这段产品边界的原文是：「文案明确只是关联，不宣称上传代码、同步会话或远程执行」──
 * 所以这里做三件**只有三件**事：存下用户给的 URL 与标题、列出来、打开网页。
 * 没有任何一处会去读代码、传文件或声称"同步"。
 *
 * 存本地（按会话隔离）而不是发给模型：这是用户自己的书签栏，不是上下文的一部分。
 * 与「已查看」标记同样的做法（本机有效、不跨设备）—— 要跨设备得先有账号体系，
 * 而我们明确不做虚假的登录/同步状态。
 */

export interface SourceLink {
  id: string
  sessionId: string
  url: string
  title: string
  addedAt: number
}

const KEY = 'yan.source-links.v1'
const MAX_LINKS = 50

function loadAll(): SourceLink[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is SourceLink =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as SourceLink).url === 'string' &&
        typeof (x as SourceLink).sessionId === 'string'
    )
  } catch {
    return []
  }
}

/** 只接受 http/https —— 免得把 `javascript:` 这类东西当成"可打开的链接" */
function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

export function SourceLinks({ sessionId, open }: { sessionId: string; open: boolean }): React.JSX.Element {
  const t = useT()
  const [all, setAll] = useState<SourceLink[]>([])
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [bad, setBad] = useState(false)

  /* 打开菜单时读一次：localStorage 是同步的，没必要放进 effect 的依赖里反复读 */
  useEffect(() => {
    if (open) setAll(loadAll())
  }, [open])

  const mine = all.filter((x) => x.sessionId === sessionId)

  const persist = (next: SourceLink[]): void => {
    setAll(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX_LINKS * 4)))
    } catch {
      /* 存不下不影响本次会话里看到的东西 */
    }
  }

  const add = (): void => {
    const clean = normalizeUrl(url)
    if (!clean) {
      setBad(true)
      return
    }
    setBad(false)
    /*
     * 标题留空就用域名 —— 列表里全是 URL 的时候很难扫，
     * 至少让每一行开头有点可读的东西。
     */
    const label = title.trim() || new URL(clean).host
    persist([
      { id: `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, sessionId, url: clean, title: label, addedAt: Date.now() },
      ...all
    ])
    setUrl('')
    setTitle('')
  }

  return (
    <div className="env-links" data-testid="env-source-links">
      <div className="env-links-head">
        <Icon name="globe" size={14} />
        <span className="env-label">{t('env.links')}</span>
        <span className="env-sub">{mine.length > 0 ? String(mine.length) : ''}</span>
      </div>

      {mine.length > 0 ? (
        <div className="env-links-list">
          {mine.map((l) => (
            <div className="env-link" key={l.id}>
              <button
                type="button"
                className="env-link-open"
                data-testid="env-link-open"
                title={l.url}
                onClick={() => {
                  /* 在内置浏览器里打开；不做任何"上传/同步"的暗示 */
                  void window.yan.browser.open(l.url)
                }}
              >
                {l.title}
              </button>
              <button
                type="button"
                className="env-mini"
                data-testid="env-link-remove"
                onClick={() => persist(all.filter((x) => x.id !== l.id))}
              >
                {t('env.linkRemove')}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="env-link-add">
        <input
          className="env-branch-input"
          data-testid="env-link-url"
          placeholder={t('env.linkUrl')}
          value={url}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value)
            setBad(false)
          }}
        />
        <input
          className="env-branch-input"
          data-testid="env-link-title"
          placeholder={t('env.linkTitle')}
          value={title}
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="button" className="env-mini" data-testid="env-link-add" disabled={!url.trim()} onClick={add}>
          {t('env.linkAdd')}
        </button>
      </div>

      {bad ? <div className="env-error">{t('env.linkBad')}</div> : null}
      {/* 边界写在界面上：这不是同步，只是记下地址 */}
      <div className="env-carry-hint">{t('env.linkNote')}</div>
    </div>
  )
}
