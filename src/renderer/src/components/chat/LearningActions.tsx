import { useT } from '../../i18n'
import { useStore } from '../../state/store'

/**
 * 学习会话的三个快捷回应（需求稿 3.3）：继续讲解 / 给个例子 / 让我试试。
 *
 * 只是把一句普通消息发出去 —— 导师如何回应由模型按角色约定决定，
 * 不开独立模式、不要求课程配置。只在「日常 · 学习」会话里、且当前没有在生成时出现；
 * 有待回答的问题时不出现（先答问题）。
 */
export function LearningActions() {
  const t = useT()
  const profile = useStore((s) => s.agentProfile)
  const busy = useStore((s) => !!s.session?.isStreaming || !!s.session?.isAgentRunning)
  const waiting = useStore((s) => s.uiRequests.length > 0)
  const hasMessages = useStore((s) => s.messages.length > 0)
  const send = useStore((s) => s.send)
  if (profile?.profile !== 'daily' || profile.activity !== 'learn' || busy || waiting || !hasMessages) return null

  const actions = [
    { key: 'continue', label: t('learn.quick.continue'), text: t('learn.quick.continueText') },
    { key: 'example', label: t('learn.quick.example'), text: t('learn.quick.exampleText') },
    { key: 'try', label: t('learn.quick.try'), text: t('learn.quick.tryText') }
  ]
  return (
    <div className="learn-actions btn-row" role="group" aria-label={t('learn.quick.label')} data-testid="learn-actions">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className="btn sm"
          data-testid={`learn-action-${action.key}`}
          onClick={() => void send(action.text)}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
