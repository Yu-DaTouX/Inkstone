import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { shortTitle } from '../../../../shared/short-title'
import { useStore } from '../../state/store'
import { EnvironmentMenu } from '../review/EnvironmentMenu'
import { GoalPopover } from '../toolbar/GoalPopover'

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
export function SessionHeader({ mapEnabled, mapOpen, onToggleMap, spaceEnabled, spaceOpen, onToggleSpace }: {
  /** 日常模式才提供「地图」这一档；编码模式不渲染切换器 */
  mapEnabled?: boolean
  /** 当前是否停在地图视图 */
  mapOpen?: boolean
  onToggleMap?: (open: boolean) => void
  /**
   * 空间概览（实施-25 P04 / T04-7）：**始终可达**。
   * 与地图同一档位置，但它回答的是「这个空间里有什么」，不是「这个会话里有什么」——
   * 所以不依赖当前会话有没有消息。
   */
  spaceEnabled?: boolean
  spaceOpen?: boolean
  onToggleSpace?: (open: boolean) => void
} = {}) {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const peekedPath = useStore((s) => s.peekedPath)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  /*
   * 「只读打开」：点开的会话没有接管运行实例（同一目录已有忙碌实例），
   * `session` 仍是那个正在跑的会话。标题、空间入口、忙碌点都要跟着**正在看的**会话走，
   * 否则界面切过去了，头部还写着上一条会话的名字。
   */
  const activeFile = session?.conversationFile ?? session?.sessionFile
  const previewing = !!peekedPath && peekedPath !== activeFile
  const previewed = previewing ? sessions.find((x) => x.path === peekedPath) : undefined

  /**
   * 标题取值顺序：
   *   ① 模型生成的短标题（本轮 agent_settled 后异步补上）
   *   ② 用户自己起的名字（session_info）
   *   ③ 会话列表里那条（pi 用首条消息算的）
   *   ④ 首条用户消息（本地兜底）
   *   ⑤ 「新会话」
   */
  const fromModel = previewing
    ? (peekedSessionId ? titles[peekedSessionId] : undefined)
    : session?.sessionId
      ? titles[session.conversationId ?? session.sessionId]
      : undefined
  const fromList = previewing ? previewed?.title : sessions.find((x) => x.path === activeFile)?.title
  const fromFirst = messages.find((m) => m.role === 'user')?.text
  /**
   * 当前会话归属的空间（决定要不要给「空间」入口）。
   *
   * 先按会话 id 找 —— 刚建出来的空会话还没有会话文件，`path` 是空的，
   * 只按 path 匹配会让「刚开会话就想去空间」变成无入口；
   * 再退回 path，是因为列表里的 id 与当前会话的 id 在分叉/接管等情形下不一定同时就绪。
   */
  const currentFile = previewing ? peekedPath : activeFile
  const spaceId = previewing
    ? previewed?.spaceId
    : (session?.sessionId ? sessions.find((x) => x.id === session.sessionId)?.spaceId : undefined) ??
      (currentFile ? sessions.find((x) => x.path === currentFile)?.spaceId : undefined)
  /**
   * 「空间」入口的显示条件。
   *
   * 除了「这个会话归属某个空间」，**列表里查不到的会话也显示**：
   * 刚开出来的会话还没落盘（只是预留了文件路径），列表里根本没它，
   * 只按归属判断会让「刚开会话就想进空间」在头部连入口都没有。
   * 查不到 ≠ 不属于任何空间，所以这时按“不知道”处理。
   * 会话在列表里且确认没归属，才是真的「这个会话不属于任何空间」——那就不给入口。
   */
  const knownInList = Boolean(currentFile) && sessions.some((x) => x.path === currentFile)
  const showSpace = Boolean(spaceId) || !knownInList
  const title =
    fromModel ||
    (previewing ? undefined : session?.sessionName) ||
    fromList ||
    (fromFirst ? shortTitle(fromFirst, 60).short : t('header.untitled'))

  return (
    <div className="shead" data-testid="session-header">
      <div className="shead-row">
        <h1 className="shead-title" title={title} data-testid="session-title">
          {title}
        </h1>

        {/*
         * 视图入口「按需出现」（实施-27 B3）。
         *
         * 以前这里是常驻的「对话 / 地图 / 概览」三档 tab，但绝大多数会话
         * 根本不会用到地图与空间 —— 常驻之后它们就变成了「每天看到但从不点」的
         * 噪音。现在的规则：
         *   · 对话永远在（默认视图）；
         *   · 有回合才给「地图」入口（没聊过就没有地图可看）；
         *   · 这个会话归档到空间了才给「空间」入口。
         * 已经打开时只显示一个「返回对话」，不再并列三个档位。
         */}
        {mapEnabled || spaceEnabled ? (
          <div className="shead-view" role="group" aria-label={t('view.switch')} data-testid="view-switch">
            {mapOpen || spaceOpen ? (
              <button
                className="on"
                onClick={() => {
                  if (spaceOpen) onToggleSpace?.(false)
                  else onToggleMap?.(false)
                }}
                data-testid="view-chat"
              >
                <Icon name="chat-round" size={12} />
                <span>{t('view.chat')}</span>
              </button>
            ) : null}
            {mapEnabled && !mapOpen && messages.length > 0 ? (
              <button
                onClick={() => onToggleMap?.(true)}
                title={t('view.map')}
                data-testid="view-map"
              >
                <Icon name="map" size={12} />
                <span>{t('view.map')}</span>
              </button>
            ) : null}
            {spaceEnabled && !spaceOpen && showSpace ? (
              <button
                onClick={() => onToggleSpace?.(true)}
                title={t('view.space')}
                data-testid="view-space"
              >
                <Icon name="layers" size={12} />
                <span>{t('view.space')}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 环境菜单（项目胶囊即入口）：变更 / 本地 / 分支 / PR / 比较分支 */}
        <EnvironmentMenu />

        {/* 目标入口（U-3a）：点开是只读浮层，不再占工具页的一块 */}
        <GoalPopover />

        {/*
         * 模型胶囊**已删**（用户要求）。
         *
         * 理由：模型名在**底部用量条的最右**已经常驻（而且那里就能点开切换），
         * 标题栏中间的「连接 · 工作目录」旁边也不再重复。
         * 会话头部再挂一个就是三处重复，而标题旁边最该留给标题本身。
         *
         * 保留的只有「正在流式」的小圆点 —— 它是**状态**，不是名称。
         */}
        {session?.isStreaming && !previewing ? (
          <span className="shead-busy" title={t('chat.working')} data-testid="shead-busy">
            <span className="shead-dot busy" />
          </span>
        ) : null}
      </div>
    </div>
  )
}

// 兼容既有 import 路径
export { SessionHeader as Continuity }
