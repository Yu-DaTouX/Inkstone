import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { Button } from './ui'

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
    this.setState({ info: info.componentStack ?? '' })
    console.error('[yan] 渲染异常：', error, info.componentStack)
  }

  private detail(): string {
    const { error, info } = this.state
    return [error?.message ?? String(error), error?.stack ?? '', info].filter(Boolean).join('\n\n')
  }

  private copy = (): void => {
    void navigator.clipboard?.writeText(this.detail()).catch(() => {
    })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <ErrorFallback detail={this.detail()} onCopy={this.copy} />
  }
}

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
          <Button onClick={onCopy} data-testid="crash-copy">
            {t('crash.copy')}
          </Button>
          <Button variant="primary" onClick={() => location.reload()} data-testid="crash-reload">
            {t('crash.reload')}
          </Button>
        </div>
      </div>
    </div>
  )
}
