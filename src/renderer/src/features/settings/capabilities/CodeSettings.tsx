import type { ReactElement } from 'react'
import { GithubSettingsGroup } from '../general/GithubSettings'
import { ConfirmProvider } from './confirm'
import { GitRuntimeSection } from './GitRuntimeSection'
import './capabilities.css'

export function CodeSettings(): ReactElement {
  return (
    <ConfirmProvider>
      <section className="settings-section" data-testid="code-settings">
        <GithubSettingsGroup />
        <div className="caps-root" data-setting-id="code-git-runtime">
          <GitRuntimeSection />
        </div>
      </section>
    </ConfirmProvider>
  )
}
