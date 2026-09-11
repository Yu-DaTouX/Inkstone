import { useT } from '../i18n'
import { useStore } from '../state/store'
import { shortProject } from './rail-utils'

/**
 * 主区域顶部 —— 对齐 Codex 的头部。
 *
 * 一行两件东西：
 *   左：会话标题（优先用**模型总结**出来的短标题）
 *   右：所属项目胶囊（没有工作目录时明确写「无项目」）
 *
 * 「上次聊到 …」那一行**已删除** ——
 *   它是设计稿里的连续性提示，但实际用起来：
 *   ① 每轮都在变，是个纯噪音源
 *   ② 左栏点会话时已经知道自己在哪个会话，重复提示没意义
 *   ③ 占掉一行高度，而主区顶部该尽量薄
 */
export function SessionHeader() {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const cwd = useStore((s) => s.settings?.cwd)
  const openSettings = useStore((s) => s.openSettings)

  /**
   * 标题取值顺序：
   *   ① 模型生成的短标题（本轮 agent_settled 后异步补上）
   *   ② 用户自己起的名字（session_info）
   *   ③ 会话列表里那条（pi 用首条消息算的）
   *   ④ 首条用户消息（本地兜底）
   *   ⑤ 「新会话」
   */
  const fromModel = session?.sessionId ? titles[session.sessionId] : undefined
  const fromList = sessions.find((x) => x.path === session?.sessionFile)?.title
  const fromFirst = messages.find((m) => m.role === 'user')?.text
  const title =
    fromModel ||
    session?.sessionName ||
    fromList ||
    (fromFirst ? truncate(fromFirst, 60) : t('header.untitled'))

  // 项目：会话自己的 cwd 优先（切到历史会话时应显示那个会话的项目）
  const project = session?.cwd ?? cwd

  return (
    <div className="shead" data-testid="session-header">
      <div className="shead-row">
        <h1 className="shead-title" title={title} data-testid="session-title">
          {title}
        </h1>

        {/* 项目胶囊：没有工作目录时明确说「无项目」，不要留空 */}
        <span
          className={`shead-proj ${project ? '' : 'none'}`}
          title={project ?? t('header.noProject')}
          data-testid="session-project"
        >
          <span className="shead-proj-ico">{project ? '▸' : '·'}</span>
          <span className="shead-proj-name">
            {project ? shortProject(project) : t('header.noProject')}
          </span>
        </span>

        {/* 模型胶囊：点它进设置的状态页 */}
        <button
          className="shead-chip"
          onClick={() => openSettings('status')}
          title={session?.model?.id}
        >
          <span className={`shead-dot ${session?.isStreaming ? 'busy' : ''}`} />
          <span className="shead-chip-text">{session?.model?.name ?? '—'}</span>
        </button>
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  const clean = s
    .replace(/\s+/g, ' ')
    .replace(/<[^>]{1,40}>/g, '')
    .trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

// 兼容既有 import 路径
export { SessionHeader as Continuity }
