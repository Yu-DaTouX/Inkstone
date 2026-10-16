import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { UsageOverview, useUsageStats } from './UsageOverview'

export function EmptyStream() {
  const t = useT()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const changeCwd = useStore((s) => s.changeCwd)
  const userName = useUsageStats('all')?.userName ?? ''

  const suggest = (text: string) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
    if (!ta) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
  }

  const pickProject = async (): Promise<void> => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }

  const startProject = async (): Promise<void> => {
    if (!cwd) {
      await pickProject()
      return
    }
    suggest(t('chat.draft1'))
  }

  const entries = [
    { icon: 'folder-open' as const, label: t('chat.entry1'), run: () => void startProject() },
    { icon: 'search' as const, label: t('chat.entry2'), run: () => suggest(t('chat.draft2')) },
    { icon: 'history' as const, label: t('chat.entry3'), run: () => suggest(t('chat.draft3')) }
  ]

  return (
    <div className="empty-stream">
      <div className="start" data-testid="start-page">
        <div className="start-main">
        <h1 className="start-greet">
          <span className="start-prompt" aria-hidden>
            ›
          </span>
          {userName ? t('chat.greetName', { name: userName }) : t('chat.greet')}
        </h1>
        <p className="start-hint">{t('chat.emptyHint')}</p>

        <section className="start-sec">
          <h2 className="start-label">{t('chat.project')}</h2>
          {cwd ? (
            <div className="start-project">
              <span className="start-path" title={cwd}>
                {cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd}
              </span>
              <button type="button" className="start-link" onClick={() => void pickProject()}>
                {t('chat.changeProject')}
              </button>
            </div>
          ) : (
            <button type="button" className="start-link" onClick={() => void pickProject()}>
              {t('chat.pickProject')}
            </button>
          )}
        </section>

        <section className="start-sec">
          <h2 className="start-label">{t('chat.startWith')}</h2>
          <div className="start-entries">
            {entries.map((e) => (
              <button type="button" key={e.label} className="start-entry" onClick={e.run}>
                <Icon name={e.icon} size={12} />
                <span>{e.label}</span>
              </button>
            ))}
          </div>
        </section>

        </div>

        <UsageOverview />
      </div>
    </div>
  )
}
