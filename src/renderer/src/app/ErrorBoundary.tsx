import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useI18n } from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * v3 自己的错误边界。
 *
 * 不用 v2 的 `components/ErrorBoundary`：那个会导入 v2 的 ui 与样式，
 * 违背「v3 不加载任何 v2 样式」。这里只兜住 v3 外壳子树的渲染异常，
 * 给一句说明和一个「重新载入」出口；细节留在 console。
 */
export class V3ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[v3-shell] 渲染异常', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <V3Fatal error={this.state.error} />
  }
}

function V3Fatal({ error }: { error: Error }): ReactNode {
  const { lang } = useI18n()
  const zh = lang !== 'en-US'
  return (
    <div className="v3-fatal" role="alert">
      <h1>{zh ? '界面出错了' : 'The interface ran into a problem'}</h1>
      <p>{zh ? '这次异常没有让会话数据丢失。重新载入可以回到界面。' : 'Your session data is safe. Reload to get back to the interface.'}</p>
      <pre className="v3-fatal-detail">{error.message}</pre>
      <button type="button" className="v3-fatal-reload" onClick={() => window.location.reload()}>
        {zh ? '重新载入' : 'Reload'}
      </button>
    </div>
  )
}
