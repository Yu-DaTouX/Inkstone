import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { PackageActionResultView, PackageListingView } from '../../../../shared/ipc'

/**
 * pi 插件（方案 §9 的 P2）。
 *
 * ── 这个界面要说清四件事（每一件都对应方案里的原话）──
 *
 * 1. **东西装在哪**：`agentDir` 是 pi 自己的 agent 目录（用户级），项目作用域是
 *    `<项目>/.pi/settings.json`。不告诉用户位置，出问题时他没法自己看。
 * 2. **谁维护**：列表里带 author / repository / 来源。「收录不代表官方维护或审核」
 *    —— 所以这里不出现任何"官方"的字样。
 * 3. **会执行代码**：扩展是**能执行任意代码**的，详情里明说来源与实际影响，
 *    **不宣称沙箱隔离**（我们也没有）。这里不做任何"安全扫描"的暗示。
 * 4. **什么时候生效**：pi 在**启动时**加载扩展，所以装完/卸完对**已经在跑**的
 *    实例没有影响 —— 界面上写清楚，并且主进程会在有任务运行时直接拒绝。
 *
 * 「安装成功 / 加载成功 / 当前会话可用」三态按方案要分开记。这里如实做前两态：
 * 安装成功 = pi 的 CLI 返回成功；加载成功 = 磁盘上真的能读到 package.json
 * （`installed`）。**不显示"当前会话可用"** —— 那需要 pi 重载，而我们没有把
 * 它当成已发生的事。
 */
export function PackagesTab(): React.JSX.Element {
  const t = useT()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [listing, setListing] = useState<PackageListingView | null>(null)
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<PackageActionResultView | null>(null)
  const [source, setSource] = useState('')
  const [local, setLocal] = useState(false)
  const [openDetail, setOpenDetail] = useState('')
  const [showRaw, setShowRaw] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setListing(await window.yan.packages.list(cwd))
    } catch (e) {
      setListing({
        ok: false,
        agentDir: '',
        userSettings: '',
        projectSettings: '',
        entries: [],
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (kind: 'install' | 'remove' | 'update', src: string): Promise<void> => {
    setBusy(`${kind}:${src}`)
    setShowRaw(false)
    const res = await window.yan.packages.action({ kind, source: src, local, cwd })
    setResult(res)
    setBusy('')
    /* 主进程会把执行后的列表带回来（省一次往返，界面立刻是对的） */
    if (res.listing) setListing(res.listing)
    else await load()
    if (res.ok && kind === 'install') setSource('')
  }

  return (
    <div className="set-group" data-testid="set-packages">
      {/* ① 目录入口：方案 §9 的 P1 */}
      <div className="set-row" data-testid="set-pi-catalog">
        <div className="set-label">
          <div className="set-name">{t('pkg.catalog')}</div>
          <div className="set-desc">{t('pkg.catalogDesc')}</div>
          <div className="set-desc">{t('pkg.catalogNote')}</div>
        </div>
        <button
          type="button"
          className="set-btn"
          data-testid="set-pi-catalog-open"
          onClick={() => void window.yan.browser.open('https://pi.dev/packages')}
        >
          {t('pkg.open')}
        </button>
      </div>

      {/* ② 安装 */}
      <div className="set-row set-row-col" data-testid="pkg-install">
        <div className="set-label">
          <div className="set-name">{t('pkg.install')}</div>
          <div className="set-desc">{t('pkg.installDesc')}</div>
        </div>
        <div className="pkg-install-row">
          <input
            className="set-input"
            data-testid="pkg-source"
            placeholder="npm:pi-zh-cn  /  npm:@scope/pkg@1.2.3"
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
          />
          <label className="pkg-local" title={t('pkg.localHint')}>
            <input
              type="checkbox"
              checked={local}
              data-testid="pkg-local"
              onChange={(e) => setLocal(e.target.checked)}
            />
            <span>{t('pkg.local')}</span>
          </label>
          <button
            type="button"
            className="set-btn"
            data-testid="pkg-install-btn"
            disabled={!!busy || !source.trim()}
            onClick={() => void run('install', source.trim())}
          >
            {busy.startsWith('install') ? t('pkg.working') : t('pkg.installBtn')}
          </button>
        </div>
      </div>

      {/* ③ 结果：成功带 pi 自己的输出，失败带原始输出（可展开） */}
      {result ? (
        <div className={result.ok ? 'pkg-ok' : 'pkg-fail'} data-testid="pkg-result">
          <div className="pkg-result-line">
            <Icon name={result.ok ? 'check-circle' : 'alert-circle'} size={12} />
            <span>{result.ok ? (result.output ?? 'ok') : (result.error ?? t('pkg.failed'))}</span>
          </div>
          {result.detail ? (
            <>
              <button
                type="button"
                className="gwrite-fail-toggle"
                data-testid="pkg-detail-toggle"
                onClick={() => setShowRaw((v) => !v)}
              >
                <Icon name="chevron-right" size={12} className={showRaw ? 'open' : ''} />
                <span>{showRaw ? t('pkg.hideRaw') : t('pkg.showRaw')}</span>
              </button>
              {showRaw ? <pre className="gwrite-fail-raw">{result.detail}</pre> : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* ④ 已装列表 */}
      <div className="set-row set-row-col" data-testid="pkg-list">
        <div className="set-label">
          <div className="set-name">{t('pkg.installed')}</div>
          <div className="set-desc" title={listing?.userSettings}>
            {t('pkg.location', { dir: listing?.agentDir ?? '—' })}
          </div>
        </div>
        {!listing || listing.entries.length === 0 ? (
          <div className="set-desc" data-testid="pkg-empty">
            {listing?.ok === false ? (listing.error ?? t('pkg.listFailed')) : t('pkg.empty')}
          </div>
        ) : (
          <div className="pkg-list">
            {listing.entries.map((e) => (
              <div className="pkg-item" key={`${e.scope}:${e.source}`} data-testid="pkg-item">
                <div className="pkg-item-main">
                  <span className="pkg-name" data-testid="pkg-name">
                    {e.name}
                  </span>
                  {e.version ? <span className="pkg-ver">{e.version}</span> : null}
                  <span className={`pkg-scope ${e.scope}`}>{e.scope === 'project' ? t('pkg.scopeProject') : t('pkg.scopeUser')}</span>
                  {/*
                    登记着但磁盘上找不到 ≠ 正常：那说明包被删了或装失败了一半，
                    用户点「更新」就能修 —— 但这必须**看得出来**。
                  */}
                  {!e.installed ? <span className="pkg-missing">{t('pkg.missing')}</span> : null}
                  <span className="pkg-spacer" />
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="pkg-detail"
                    onClick={() => setOpenDetail(openDetail === e.source ? '' : e.source)}
                  >
                    {openDetail === e.source ? t('pkg.hideDetail') : t('pkg.detail')}
                  </button>
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="pkg-update"
                    disabled={!!busy}
                    onClick={() => void run('update', e.source)}
                  >
                    {t('pkg.update')}
                  </button>
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="pkg-remove"
                    disabled={!!busy}
                    onClick={() => void run('remove', e.source)}
                  >
                    {t('pkg.remove')}
                  </button>
                </div>

                {openDetail === e.source ? (
                  <div className="pkg-detail" data-testid="pkg-detail-body">
                    <div className="pkg-detail-line">{e.description ?? t('pkg.noDesc')}</div>
                    <div className="pkg-detail-line pkg-dim">{t('pkg.sourceLine', { src: e.source })}</div>
                    {e.repository ? <div className="pkg-detail-line pkg-dim">{t('pkg.repoLine', { url: e.repository })}</div> : null}
                    {e.license ? <div className="pkg-detail-line pkg-dim">{t('pkg.licenseLine', { license: e.license })}</div> : null}
                    {/*
                      这一句是方案 §9 的硬要求：「说明来源与实际影响，不宣称沙箱隔离」。
                      它不是提示语，是这个功能的边界声明 —— 别为了整洁删掉。
                    */}
                    <div className="pkg-detail-warn" data-testid="pkg-warn">
                      {t('pkg.warn')}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ⑤ 生效时机（方案 §9：任务运行中要安排安全的生效时机） */}
      <div className="set-row" data-testid="pkg-effect">
        <div className="set-label">
          <div className="set-desc">{t('pkg.effect')}</div>
        </div>
      </div>
    </div>
  )
}
