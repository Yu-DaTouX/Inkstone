/**
 * 工作区「分支」页签（v3 · WP-30）。
 *
 * 只做两件事：把正式宿主桥接成 `BranchTransport`，以及把**当前视图的归属**与
 * 会话忙状态喂给 `BranchTree`。树、折叠、键盘、切换与迟到响应守卫都在
 * `features/session/BranchTree.tsx`，本文件不复制第二套。
 *
 * 归属纪律：
 *   · 请求与切换都绑定 `owner.sessionId`（`BranchTree` 负责），因此只对当前视图的
 *     会话生效；`owner` 变化时在途响应作废；
 *   · 会话忙（运行 / 流式 / 压缩中）时禁用切换，和主进程守卫同一口径；
 *   · 切换成功后调 `refreshSessions()` 走既有宿主 sync 刷新会话列表，不自己在
 *     渲染端改消息投影。
 *
 * 宿主桥可选：preload 尚未暴露 `yan.nativeSession` 时返回明确失败，界面显示
 * 「尚未提供原生会话桥」，不伪造空树、不放假的切换按钮。
 */
import { useMemo, useRef, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton } from '../../ui'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../shared/native-session-host'
import { BranchTree, branchText, type BranchTransport } from '../session/BranchTree'
import type { BranchPaneProps } from './types'

interface NativeSessionIpc {
  nativeSession?: (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>
}

function bridge(): NativeSessionIpc['nativeSession'] {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yan?: NativeSessionIpc }).yan?.nativeSession
}

export function BranchPane({ owner }: BranchPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = useMemo(() => branchText(lang), [lang])
  const textRef = useRef(text)
  textRef.current = text

  /* 稳定的 transport：宿主缺失时给明确失败，界面不伪造成功。 */
  const transport = useMemo<BranchTransport>(
    () => ({
      request: async (request) => {
        const fn = bridge()
        if (!fn) return { ok: false, error: textRef.current.bridgeMissing }
        return fn(request)
      }
    }),
    []
  )

  const [reloadToken, setReloadToken] = useState(0)

  const busy = useStore((s) => {
    if (!owner.sessionId || s.session?.sessionId !== owner.sessionId) return false
    return !!(s.session?.isAgentRunning || s.session?.isStreaming || s.session?.isCompacting)
  })

  const onNavigated = useMemo(
    () => () => {
      void useStore.getState().refreshSessions()
    },
    []
  )

  return (
    <section className="wb-branch" aria-label={text.title} data-testid="v3-wb-branch">
      <header className="wb-branch__head">
        <h2 className="wb-branch__title">{text.title}</h2>
        <IconButton
          size="sm"
          aria-label={text.refresh}
          title={text.refresh}
          data-testid="branch-refresh"
          onPress={() => setReloadToken((value) => value + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </IconButton>
      </header>
      <p className="wb-branch__hint">{text.hint}</p>
      <BranchTree
        className="wb-branch__tree"
        owner={owner}
        transport={transport}
        busy={busy}
        reloadToken={reloadToken}
        onNavigated={onNavigated}
      />
    </section>
  )
}
