import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { isStaleChunkError } from '../lib/preload-recovery'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

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
  // 构建产物更新后旧窗口的懒加载会失败：这不是缺陷，说明清楚并让用户重载即可。
  const stale = isStaleChunkError(error.message)
  return (
    <div className="v3-fatal" role="alert">
      <h1>{stale ? (zh ? '应用已经更新' : 'The app was updated') : zh ? '界面出错了' : 'The interface ran into a problem'}</h1>
      <p>
        {stale
          ? zh
            ? '这个窗口还停留在旧版本，重新载入就会回到新版本。会话数据没有丢失。'
            : 'This window is still on the previous build. Reload to switch to the new version. Your sessions are safe.'
          : zh
            ? '这次异常没有让会话数据丢失。重新载入可以回到界面。'
            : 'Your session data is safe. Reload to get back to the interface.'}
      </p>
      <pre className="v3-fatal-detail">{error.message}</pre>
      <button type="button" className="v3-fatal-reload" onClick={() => window.location.reload()}>
        {zh ? '重新载入' : 'Reload'}
      </button>
    </div>
  )
}
