import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { EnvironmentMenu } from '../review/EnvironmentMenu'

/**
 * 主区域顶部 —— 对齐 Codex 的头部。
 *
 * 一行两件东西：
 *   左：会话标题（优先用**模型总结**出来的短标题）
 *   右：所属项目胶囊（没有工作目录时明确写「无项目」）
 *
 * 项目胶囊现在是**环境菜单的入口**（方案 G1 §3.1）：点开能看到变更、
 * 工作目录、当前分支、Pull Request 与比较分支。以前它只是一个静态标签，
 * 而「我现在跑在哪个环境里」是用户最需要随时确认的一件事。
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

  return (
    <div className="shead" data-testid="session-header">
      <div className="shead-row">
        <h1 className="shead-title" title={title} data-testid="session-title">
          {title}
        </h1>

        {/* 环境菜单（项目胶囊即入口）：变更 / 本地 / 分支 / PR / 比较分支 */}
        <EnvironmentMenu />

        {/*
         * 模型胶囊**已删**（用户要求）。
         *
         * 理由：模型名在**底部用量条的最右**已经常驻（而且那里就能点开切换），
         * 标题栏中间的「连接 · 工作目录」旁边也不再重复。
         * 会话头部再挂一个就是三处重复，而标题旁边最该留给标题本身。
         *
         * 保留的只有「正在流式」的小圆点 —— 它是**状态**，不是名称。
         */}
        {session?.isStreaming ? (
          <span className="shead-busy" title={t('chat.working')} data-testid="shead-busy">
            <span className="shead-dot busy" />
          </span>
        ) : null}
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
