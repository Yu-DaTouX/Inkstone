import { Icon, type IconName } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { SpaceView } from '../../state/space-view'
import type { AgentActivity } from '../../../../shared/agent-profile'

/**
 * 工作对象条（实施-25 P04 / T04-6）。
 *
 * 右栏的入口随**当前活动**变：研究看来源、创作看成果、学习看材料、办事看对象。
 * 活动本身来自 P01 的活动档案（`agentProfile.activity`），这里只做投影。
 *
 * ⚠️ 只做「入口」不做「面板」：四种活动各自的专属面板要以成果（P06）与
 *   学习工作区（P09）为底，现在都没有。所以这一条给出的是**真实可用的入口**
 *   （跳到中栏空间视图的对应页），而不是四个画好了但点不动的空壳。
 *
 * `answer`（简单问答）刻意**没有**工作对象：设计稿里问答不建任务、不建成果，
 * 这里给它一个入口会与那条约定打架。
 */
const LABEL_KEY = {
  answer: 'space.obj.answer',
  research: 'space.obj.research',
  compose: 'space.obj.compose',
  organize: 'space.obj.organize',
  learn: 'space.obj.learn'
} as const

const TARGET: Record<AgentActivity, { view: SpaceView; icon: IconName } | null> = {
  answer: null,
  research: { view: 'library', icon: 'folder-open' },
  compose: { view: 'artifact', icon: 'file' },
  organize: { view: 'overview', icon: 'checklist' },
  /* 学习在对话里进行（tutor 技能），没有单独的工作对象页 */
  learn: null
}

export function WorkObjectBar(): React.JSX.Element | null {
  const t = useT()
  const stored = useStore((s) => s.agentProfile)
  const openSpaceView = useStore((s) => s.openSpaceView)

  /*
   * 只有**手动锁定**到某个日常活动时才显示工作对象条。
   *
   * 为什么不能只看 activity：它是按会话记住的「上次选过的活动」。
   *   · `auto`（默认）下活动由模型当场判断，这条工作对象与这轮对话无关；
   *   · `coding` 下图旧会显示上次那个日常活动的入口。
   *   · auto 档默认 activity=answer 时，还会错误地弹出「问答不建工作对象」——
   *     用户重启后看到的就是这个。
   */
  const profile = stored?.profile
  const activity = stored?.activity
  if (!stored || profile !== 'daily' || !activity) return null
  const target = TARGET[activity]

  return (
    <div className="rp-workobj" data-testid="rp-workobj">
      <span className="rp-workobj-activity" data-testid="rp-workobj-activity">
        <Icon name="activity" size={12} />
        {t(LABEL_KEY[activity])}
      </span>
      <span className="spacer" />
      {target ? (
        <button
          className="rp-workobj-open"
          data-testid="rp-workobj-open"
          onClick={() => openSpaceView(target.view)}
          title={t('space.obj.open')}
        >
          <Icon name={target.icon} size={12} />
          {t('space.obj.open')}
        </button>
      ) : (
        <span className="rp-workobj-hint">{t('space.obj.answerHint')}</span>
      )}
    </div>
  )
}
