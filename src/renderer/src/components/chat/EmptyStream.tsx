import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

/**
 * 空状态。
 *
 * 这是「界面难看」的最大来源 —— 会话为空时三栏都是空的，
 * 中间一大片死寂，只有一行 12.5px 的小字。
 *
 * 重做思路：给空状态**内容**，而不是给装饰。
 *   · 一个符号（它是谁）
 *   · 一句能读懂的话
 *   · 当前项目路径（次级信息，不抢主标题）
 *   · 三个编码任务的入口（把空白变成入口）
 *   · 斜杠命令提示（发现性）
 *
 * ⚠️ 文案方向（方案 3.2）：围绕**编码任务**，不是泛聊天。
 *   「从一个编码任务开始。」+「描述你想实现的功能，或拖入文件」。
 *   同时删掉了未经验证的「记忆」承诺 —— 那个功能已经移除。
 *
 * ⚠️ 入口按钮的**标签**与**草稿**是两件事：
 *   标签是短词（了解这个项目），草稿是要发给模型的自然语言。
 *   点击只填入可编辑草稿，由用户自己发送，不自动跑命令。
 */
export function EmptyStream() {
  const t = useT()
  const commands = useStore((s) => s.commands)
  /** 项目路径：会话运行时用 session.cwd，没有就用设置里选定的目录 */
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const changeCwd = useStore((s) => s.changeCwd)

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

  return (
    <div className="empty-stream">
      <div className="empty-mark" aria-hidden>
        <span>✦</span>
      </div>

      <div className="empty-title">{t('chat.empty')}</div>
      <div className="empty-hint">{t('chat.emptyHint')}</div>

      {/* 当前项目：次级信息，压在入口下面一行 */}
      <div className={`empty-project ${cwd ? '' : 'none'}`}>
        <Icon name="folder" size={12} />
        <span className="empty-project-label">{t('chat.project')}</span>
        {cwd ? (
          <span className="empty-project-path" title={cwd}>
            {cwd}
          </span>
        ) : (
          <button className="empty-project-pick" onClick={() => void pickProject()}>
            {t('chat.pickProject')}
          </button>
        )}
      </div>

      {/* 三个编码任务入口 */}
      <div className="empty-suggest">
        <button className="empty-sug" onClick={() => void startProject()}>
          <Icon name="folder-open" size={12} />
          <span>{t('chat.entry1')}</span>
        </button>
        <button className="empty-sug" onClick={() => suggest(t('chat.draft2'))}>
          <Icon name="search" size={12} />
          <span>{t('chat.entry2')}</span>
        </button>
        <button className="empty-sug" onClick={() => suggest(t('chat.draft3'))}>
          <Icon name="history" size={12} />
          <span>{t('chat.entry3')}</span>
        </button>
      </div>

      {/* 斜杠命令：发现性 —— 用户装了扩展也未必知道有命令 */}
      {commands.length > 0 ? (
        <div className="empty-cmds">
          <span className="empty-cmds-label">{t('chat.cmds')}</span>
          {commands.slice(0, 6).map((c) => (
            <button key={c.name} className="empty-cmd" onClick={() => suggest(`/${c.name} `)} title={c.description}>
              /{c.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
