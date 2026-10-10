import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { UsageOverview, useUsageStats } from './UsageOverview'

/**
 * 空会话的启动页（设计规范「启动页」）。
 *
 * 与对话正文同一种终端排版，不对称两栏：左侧宽栏是提示符 `›` 起头的问候、
 * 当前项目与开始入口（竖排）；右侧窄栏下沉一截放本机用量。斜杠命令不在这里列（输入 `/` 时有提示）。
 * 各段只用小标题与留白分组，不加卡片底色与外框；窄时两栏叠成一列。
 *
 * 入口按钮的**标签**与**草稿**是两件事：标签是短词，草稿是要发给模型的自然语言。
 * 点击只填入可编辑草稿，由用户自己发送，不自动跑命令。
 */
export function EmptyStream() {
  const t = useT()
  /** 项目路径：会话运行时用 session.cwd，没有就用设置里选定的目录 */
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const changeCwd = useStore((s) => s.changeCwd)
  /* 称呼用本机用户名（与用量同一次请求，结果已缓存） */
  const userName = useUsageStats('all')?.userName ?? ''

  /** 建议：点了就填进输入框并聚焦 */
  const suggest = (text: string) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
    if (!ta) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
  }

  /** 选项目：走设置页同一个入口（主进程弹目录选择框） */
  const pickProject = async (): Promise<void> => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }

  /** 「了解这个项目」：没选项目时先引导选项目，而不是发一句空话 */
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
                {cwd}
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
