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
