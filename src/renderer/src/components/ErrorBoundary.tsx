import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'

/**
 * 渲染异常的兜底界面（D8）。
 *
 * 为什么必须有：React 18 在渲染期抛错会卸载整棵树 —— 用户看到的是**整屏白**，
 * 没有任何解释，也没有出口（只能靠重启应用）。而砚是本地常驻应用，
 * 它自己崩一次就够让用户以为“坏了”。
 *
 * 这里只做三件事：说清发生了什么、把细节留给用户能复制、给一个重新加载。
 * 不尝试“自动恢复”（重置 state 重渲染）—— 渲染期错误多数来自数据形状，
 * 自动重试通常还是同样的崩溃，反而把用户的错误现场冲掉。
 *
 * 注意：它抓不到**事件处理器 / 异步回调**里的异常（React 不会把它们
 * 抛到这里）。那类错误走主进程日志与 notice，两者互补。
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /* 组件栈对定位很关键（哪一层崩的），但不要塞进界面里吓用户 */
    this.setState({ info: info.componentStack ?? '' })
    /* 打到控制台：主进程日志会收走它（用户报问题时能直接给这一段） */
    console.error('[yan] 渲染异常：', error, info.componentStack)
  }

  private detail(): string {
    const { error, info } = this.state
    return [error?.message ?? String(error), error?.stack ?? '', info].filter(Boolean).join('\n\n')
  }

  private copy = (): void => {
    void navigator.clipboard?.writeText(this.detail()).catch(() => {
      /* 剪贴板不可用就算了：下面还能手动选中文本 */
    })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <ErrorFallback detail={this.detail()} onCopy={this.copy} />
  }
}

/**
 * 兜底界面本身也走 i18n。
 *
 * ⚠️ 不能用 `useT()` 的实现细节之外的东西（比如 store）：崩溃时 store 可能
 * 正好是出错的那一环，兜底界面要尽量自给自足。
 */
function ErrorFallback({ detail, onCopy }: { detail: string; onCopy: () => void }): ReactNode {
  const t = useT()
  return (
    <div className="crash" data-testid="crash-screen">
      <div className="crash-card">
        <div className="crash-head">
          <Icon name="alert-circle" size={14} />
          <span>{t('crash.title')}</span>
        </div>
        <p className="crash-body">{t('crash.body')}</p>
        <pre className="crash-detail" data-testid="crash-detail">
          {detail.slice(0, 4000)}
        </pre>
        <div className="crash-actions">
          <button className="btn" onClick={onCopy} data-testid="crash-copy">
            {t('crash.copy')}
          </button>
          <button
            className="btn primary"
            onClick={() => location.reload()}
            data-testid="crash-reload"
          >
            {t('crash.reload')}
          </button>
        </div>
      </div>
    </div>
  )
}
