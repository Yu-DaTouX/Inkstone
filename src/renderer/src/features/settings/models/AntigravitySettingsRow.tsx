import { useI18n } from '../../../i18n'
import { useAntigravityDiscovery } from '../../../state/antigravity-discovery'
import { useStore } from '../../../state/store'
import { providerFavicon } from '../../../patterns/provider-favicon'
import { Badge, Button } from '../../../ui'

export function AntigravitySettingsRow() {
  const { lang } = useI18n()
  const en = lang === 'en-US'
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd)
  const { discovery, discover } = useAntigravityDiscovery(cwd)
  const count = discovery?.models?.length ?? 0
  const empty = discovery?.models?.length === 0
  const actionLabel = discovery?.loading ? (en ? 'Checking…' : '正在检测…')
    : discovery?.error || empty ? (en ? 'Retry discovery' : '重新检测')
      : count > 0 ? (en ? 'Refresh models' : '刷新模型') : (en ? 'Connect CLI' : '连接 CLI')
  return (
    <div className="ms-service" data-setting-id="models-antigravity" data-testid="ms-service-antigravity">
      <div className="ms-service-main">
        <span className="ms-service-head">
          <img src={providerFavicon('antigravity') ?? undefined} width={20} height={20} alt="" />
          <span className="ms-service-name">Antigravity</span>
          {count > 0 ? <Badge tone="ok">{en ? `${count} models` : `${count} 个模型`}</Badge> : null}
        </span>
        <p className="ms-service-hint">{en ? 'Use the Google account signed in to the Antigravity CLI.' : '复用 Antigravity CLI 中已登录的 Google 账号。'}</p>
      </div>
      <div className="ms-service-actions">
        <Button variant="secondary" isDisabled={!cwd} isPending={discovery?.loading} onPress={() => discover(true)} data-testid="ms-antigravity-connect">
          {actionLabel}
        </Button>
        <Button variant="secondary" onPress={() => void window.yan.browser.openExternal('https://antigravity.google/docs/cli/acp')}>
          {en ? 'Install or sign in' : '安装或登录'}
        </Button>
      </div>
      {!discovery?.loading && (discovery?.error || empty) ? (
        <p className="ms-service-env" role="status">{discovery?.error ?? (en ? 'The CLI returned no models.' : 'CLI 没有返回可用模型。')}</p>
      ) : null}
    </div>
  )
}
